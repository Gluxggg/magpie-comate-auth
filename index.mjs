// 文心快码 Baidu Comate → magpie：账号卡片（会员 / 席位积分 / 增购 / 赠送）+ 15 个模型。
//
// 百度搭子的 Pro/Max 会员与文心快码的会员权益是同一套：搭子下的订单，积分落在
// Comate 这边（comate.baidu.com 个人中心的「席位积分」）。搭子自己的配额接口看不到
// 这份积分，所以在 magpie 里加一个 Comate 账号卡片，才能看见会员那 25,000 分。
//
// Comate 没有公开的 OpenAI 兼容 API，但官方 CLI（@comate/zulu）能跑 Ask 模式，
// 所以插件自己起一个 127.0.0.1 上的兼容口，把 /v1/chat/completions 翻译成 `zulu run`。
// 服务随插件生命周期起落，删插件即消失；没装 CLI 时自动退化成纯额度卡片。
//
// 本插件只读 magpie 的凭据：不写 magpie 的配置，只写一份用量缓存（comate-usage-cache.json）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"

const PROVIDER_ID = "comate"
const PROVIDER_NAME = "文心快码 Comate"

const BASE = "https://comate.baidu.com"
const USER_CENTER = "https://comate.baidu.com/zh/user"
const LOGIN_URL =
  "https://passport.baidu.com/v2/?login&tpl=mn&u=" + encodeURIComponent("https://comate.baidu.com/zh/user")

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// Comate 靠百度 passport 的 BDUSS 认人；BDUSS_BFESS 是同一份值的 HTTPS 版本。
const REQUIRED_COOKIES = ["BDUSS"]

const cardText = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)

// magpie 的凭据库在 <data>/plugin-auth.json。插件可能是原地加载（plugin add <路径>），
// 也可能是拷进 <data>/plugins/node_modules/<name>/，两种都要找得到：
// 先看 magpie 自己报的数据目录 / 可执行文件位置，再看插件自身位置，最后看 cwd。
function magpieAuthFiles() {
  const dirs = []
  if (process.env.MAGPIE_DATA) dirs.push(process.env.MAGPIE_DATA)
  for (const p of [process.execPath, process.argv?.[0], process.argv?.[1]]) {
    if (!p || !/magpie/i.test(String(p))) continue
    const d = dirname(String(p))
    dirs.push(d, join(d, ".."))
  }
  try {
    const pd = dirname(pathOf(new URL(import.meta.url)))
    // 装进 node_modules 时：<data>/plugins/node_modules/<name>/ → 上溯三级是 <data>
    dirs.push(resolve(pd, "../../.."), resolve(pd, "../../../.."))
  } catch {}
  try {
    dirs.push(process.cwd())
  } catch {}

  const seen = new Set()
  const out = []
  for (const d of dirs) {
    if (!d) continue
    for (const cand of [join(d, "data", "plugin-auth.json"), join(d, "plugin-auth.json")]) {
      const norm = String(cand).replace(/\\/g, "/")
      if (seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

function pathOf(u) {
  // Windows: file:///C:/somewhere/data/... → /C:/somewhere/... → C:/somewhere/...
  let p = decodeURIComponent(u.pathname)
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

// 读 magpie 里任意 provider 的 cookies（只读）。用于「复用已登录的百度账号」。
function readMagpieCookies(providerIds = ["dumate", "comate"]) {
  for (const file of magpieAuthFiles()) {
    if (!existsSync(file)) continue
    let data
    try {
      data = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    for (const id of providerIds) {
      const entry = data?.[id]
      const cookies = Array.isArray(entry?.cookies) ? entry.cookies : null
      if (!cookies?.length) continue
      if (!cookies.some((c) => c?.name === "BDUSS")) continue
      return { cookies, accountId: entry.accountId, name: entry.name }
    }
  }
  return null
}

function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(";")) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf("=")
    if (i <= 0) continue
    const name = s.slice(0, i).trim()
    const value = s.slice(i + 1).trim()
    if (!name || !value) continue
    out.push({ name, value, domain: ".baidu.com" })
  }
  // 去重，后者覆盖前者
  const map = new Map()
  for (const c of out) map.set(c.name, c)
  return [...map.values()]
}

function buildCookieHeader(cookies, hostname = "comate.baidu.com") {
  const h = String(hostname).toLowerCase()
  const pick = (cookies ?? []).filter((c) => {
    const name = String(c?.name ?? "").toLowerCase()
    // console.bce.baidu.com 的 bce-* 会话属于百度智能云控制台；带着它们访问
    // comate.baidu.com 会让服务端走 BCE 鉴权并判「没有授权」。x-bce-login-redirect-url
    // 这几个不在其内，要留着。
    if (name.startsWith("bce-")) return false
    const d = String(c?.domain ?? "").toLowerCase().replace(/^\./, "")
    if (!d) return true
    return h === d || h.endsWith("." + d)
  })
  return pick.map((c) => `${c.name}=${c.value}`).join("; ")
}

function missingCookies(cookies, required) {
  return required.filter((n) => !(cookies ?? []).some((c) => c?.name === n))
}

function signInError(message) {
  const err = new Error(message || "文心快码登录态已失效，请重新登录")
  err.signIn = "expired"
  return err
}

async function getJsonOnce(path, cookieHeader, timeoutMs) {
  const res = await fetch(BASE + path, {
    method: "GET",
    headers: {
      Cookie: cookieHeader,
      "User-Agent": UA,
      Accept: "application/json",
      Referer: USER_CENTER,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw signInError(`Comate 拒绝访问（HTTP ${res.status}），请重新登录`)
  if (/^\s*</.test(text)) throw signInError("Comate 返回了登录页，登录态已失效")
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Comate 返回非 JSON（HTTP ${res.status}）`)
  }
  const status = String(json?.status ?? "").toUpperCase()
  if (status === "UNAUTHORIZED" || status === "NOT_LOGIN" || status === "FORBIDDEN") {
    // Comate 在短时间内被连打几次就会回「没有授权!」，并不是登录真的失效：
    // 所以这里不带 signIn，免得 magpie 把账号标成过期；过几分钟自然恢复。
    const err = new Error(`Comate 暂时拒绝请求（${cardText(json?.message) || status}），稍后再刷新`)
    err.code = "FLAKY_UNAUTHORIZED"
    throw err
  }
  if (status && status !== "OK") throw new Error(`Comate 接口错误（${path}）：${cardText(json?.message) || status}`)
  return json?.data
}

// 不重试：Comate 的「没有授权!」就是请求打太快了，再补一次只会更糟。
async function getJson(path, cookieHeader, { timeoutMs = 15000 } = {}) {
  return getJsonOnce(path, cookieHeader, timeoutMs)
}

// 卡片刷新很频繁，Comate 又不喜欢同一登录态连发：同一份 cookies 的用量 10 分钟内复用。
// CLI 每次调用是新进程（模块级 Map 会丢），所以再落一份到磁盘，GUI 和 CLI 共用。
const usageCache = new Map()
const CACHE_TTL_MS = 600_000
const CACHE_FILE = "comate-usage-cache.json"

function dataDir() {
  for (const f of magpieAuthFiles()) {
    try {
      if (existsSync(f)) return dirname(f)
    } catch {}
  }
  return ""
}

function readDiskCache() {
  try {
    const d = dataDir()
    if (!d) return null
    const p = join(d, CACHE_FILE)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, "utf8"))
    return j?.at && j?.data ? j : null
  } catch {
    return null
  }
}

function writeDiskCache(data) {
  try {
    const d = dataDir()
    if (!d) return
    writeFileSync(join(d, CACHE_FILE), JSON.stringify({ at: Date.now(), data }), "utf8")
  } catch {}
}

const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const packOf = (p) => ({
  total: num(p?.totalPoints),
  used: num(p?.usedPoints),
  available: p?.availablePoints == null ? num(p?.totalPoints) - num(p?.usedPoints) : num(p?.availablePoints),
})

// "2026-12-12 23:59:59" → ISO；解析不了返回 null
function parseCnTime(s) {
  if (!s) return null
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).toISOString()
}

async function loadIcon() {
  for (const rel of ["./icon.png", "./icon.svg"]) {
    try {
      const p = pathOf(new URL(rel, import.meta.url))
      if (!existsSync(p)) continue
      const buf = readFileSync(p)
      const mime = rel.endsWith(".svg") ? "image/svg+xml" : "image/png"
      return `data:${mime};base64,${buf.toString("base64")}`
    } catch {}
  }
  return "data:image/svg+xml;base64," + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2932E1"/><text x="32" y="42" font-size="28" font-family="sans-serif" fill="#fff" text-anchor="middle">码</text></svg>`,
  ).toString("base64")
}

const pluginIcon = await loadIcon()

// ───────────────────────────── 模型：走官方 zulu CLI，插件内起一个 OpenAI 兼容口 ─────────────────────────────
//
// Comate 没有公开的 OpenAI 兼容 API，但官方 CLI（@comate/zulu）能用 license 登录并跑 Ask 模式。
// 所以插件自己在 127.0.0.1 上起一个小服务，把 /v1/chat/completions 翻译成 `zulu run --mode Ask`，
// magpie 看到的就是一个普通的 OpenAI 兼容 provider。服务随插件生命周期起落，删插件即消失。
//
// 关键坑：zulu 的 API_MAP 里没有 SAAS 平台，默认掉到内网域名 comate.baidu-int.com；
// 必须显式 HTTP_HOST=https://comate.baidu.com，否则报 ENOTFOUND / TLS 断开。

const PROXY_PORT = Number(process.env.COMATE_PROXY_PORT ?? 3427)

// 实测自 `zulu list-model`。label 是传给 -m 的显示名。
const MODELS = [
  { id: "deepseek-v4-flash", label: "Deepseek V4 Flash", vision: false },
  { id: "deepseek-v4-pro", label: "Deepseek V4 Pro", vision: false },
  { id: "deepseek-v4.1-flash", label: "Deepseek V4.1 Flash", vision: true, effort: ["low", "high", "max"] },
  { id: "ernie-5.5-flash-preview", label: "ERNIE 5.5 Flash Preview", vision: true },
  { id: "glm-4.7-fc", label: "GLM-4.7", vision: false },
  { id: "glm-5-turbo-fc", label: "GLM-5-Turbo", vision: false },
  { id: "glm-5.1", label: "GLM-5.1", vision: false },
  { id: "glm-5.2", label: "GLM-5.2", vision: false },
  { id: "glm-5.3", label: "GLM-5.3", vision: false, effort: ["low", "high", "max"] },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", vision: true },
  { id: "glm-5v-turbo", label: "GLM-5v-Turbo", vision: true },
  { id: "kimi-k2.6-oneapi", label: "Kimi-K2.6", vision: true },
  { id: "minimax-m2.5-fc", label: "MiniMax M2.5", vision: false },
  { id: "minimax-m3", label: "MiniMax M3", vision: true },
  { id: "minimax-m2.7-fc", label: "MiniMax-M2.7", vision: false },
]

const modelOf = (name) => MODELS.find((m) => m.id === name || m.label === name) ?? MODELS[0]

function modelEntry(m, baseURL) {
  return [
    m.id,
    {
      id: m.id,
      name: m.label,
      provider: { npm: "@ai-sdk/openai-compatible", ...(baseURL ? { api: baseURL } : {}) },
      limit: { context: 128000, output: 8192 },
      reasoning: true,
      tool_call: false,
      attachment: !!m.vision,
      modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] },
    },
  ]
}

function selfDir() {
  try {
    return dirname(pathOf(new URL(import.meta.url)))
  } catch {
    return ""
  }
}

// magpie 自己是 Bun 编译的 exe，process.execPath 指不到 node，得自己找。
// 只按环境变量 / PATH / 常见安装位置找，不写死任何机器路径。
function findNode() {
  const isWin = process.platform === "win32"
  const exe = isWin ? "node.exe" : "node"
  const cands = [process.env.COMATE_NODE]
  // 如果插件是被 node 加载的（开发/测试），直接用同一个 node
  if (process.execPath && !/magpie/i.test(process.execPath)) cands.push(process.execPath)
  for (const dir of String(process.env.PATH ?? "").split(isWin ? ";" : ":")) {
    if (dir.trim()) cands.push(join(dir.trim(), exe))
  }
  cands.push(join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", exe))
  cands.push(isWin ? "C:/Program Files/nodejs/node.exe" : "/usr/local/bin/node")
  for (const c of cands) {
    try {
      if (c && existsSync(c)) return c
    } catch {}
  }
  return exe
}

function zuluCli() {
  return join(selfDir(), "node_modules", "@comate", "zulu", "bin", "cli.mjs")
}

// 把 OpenAI 的 messages 拼成 zulu 的单条 query。zulu 是 agent，不是多轮 chat API。
function toQuery(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === "system" ? "系统设定" : m?.role === "assistant" ? "助手" : "用户"
    let text = ""
    if (typeof m?.content === "string") text = m.content
    else if (Array.isArray(m?.content)) text = m.content.map((c) => c?.text ?? "").join("")
    if (text.trim()) parts.push(`${role}：${text.trim()}`)
  }
  return parts.join("\n\n")
}

// Windows 的 CreateProcess 命令行上限约 32k 字符，Hermes 一轮带完整历史很容易顶破，
// 所以长上下文不走 -q，写成文件用 --attach-file 传（Ask 模式能读附件，实测有效）。
const MAX_QUERY_CHARS = 8000

function runZulu(query, modelLabel, { cid, images = [], timeoutMs = 240000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const cli = zuluCli()
    if (!existsSync(cli)) {
      return reject(new Error("zulu CLI 没装：node_modules/@comate/zulu 不存在，先在插件目录 npm i @comate/zulu"))
    }
    const args = [cli, "run", "-m", modelLabel, "--mode", "Ask", "-d", "delta-stream"]
    if (cid) args.push("-c", cid) // 复用会话：只发增量，服务端自己有历史
    for (const img of images) args.push("--attach-image", img)

    let ctxFile = ""
    if (query.length > MAX_QUERY_CHARS) {
      try {
        ctxFile = join(imageDir(), `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
        writeFileSync(ctxFile, query, "utf8")
        args.push("-q", "请阅读附加的文件，按其中最后提出的要求回答。")
        args.push("--attach-file", ctxFile)
      } catch {
        ctxFile = ""
        args.push("-q", query.slice(0, MAX_QUERY_CHARS))
      }
    } else {
      args.push("-q", query)
    }

    const cleanup = () => {
      if (!ctxFile) return
      try {
        unlinkSync(ctxFile)
      } catch {}
      ctxFile = ""
    }

    const child = spawn(findNode(), args, {
      env: { ...process.env, HTTP_HOST: BASE },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {}
      cleanup()
      reject(new Error(`zulu 超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)

    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      reject(e)
    })
    child.on("close", () => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      let content = ""
      let status = ""
      let lastErr = ""
      let gotCid = ""
      for (const line of out.split("\n")) {
        const s = line.trim()
        if (!s.startsWith("{")) continue
        try {
          const j = JSON.parse(s)
          if (j.cid) gotCid = j.cid
          if (j.kind === "element-add" && j.element?.type === "EXCEPTION") lastErr = j.element.content ?? ""
          if (j.kind === "completed") {
            content = j.content ?? ""
            status = j.status ?? ""
            if (j.cid) gotCid = j.cid
          }
        } catch {}
      }
      if (status === "ok") resolvePromise({ text: content, cid: gotCid })
      else reject(new Error(content || lastErr || err.trim() || "zulu 没有返回内容"))
    })
  })
}

function readJsonBody(req) {
  return new Promise((r) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        r(JSON.parse(raw || "{}"))
      } catch {
        r({})
      }
    })
  })
}

// ── 多轮：OpenAI 客户端每次都把全量历史发过来，但 zulu 自己有会话，只该收增量。
// 认「这是同一个会话」的办法：上一轮我返回的 assistant 文本，这一轮必然出现在 messages 里。
const REPLY_INDEX = new Map() // hash(assistant 文本) → conversationId
const REPLY_LIMIT = 300

function quickHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return String(h)
}

function textOf(m) {
  if (typeof m?.content === "string") return m.content
  if (Array.isArray(m?.content)) return m.content.map((c) => c?.text ?? "").join("")
  return ""
}

function findCid(messages, sessionKey) {
  // ① 客户端如果给了明确的会话标识（header / prompt_cache_key），优先用它
  if (sessionKey) {
    const cid = REPLY_INDEX.get("k:" + sessionKey)
    if (cid) return cid
  }
  // ② 兜底：上一轮我返回的 assistant 文本，客户端这一轮必然带回来
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue
    const cid = REPLY_INDEX.get(quickHash(textOf(messages[i])))
    if (cid) return cid
  }
  return ""
}

// 只认「明确是会话」的标识。不用 OpenAI 的 `user` 字段——那是用户身份，
// 拿它当会话 key 会把同一用户的不同对话串成一条。
function explicitSession(body, headers) {
  const cands = [
    body?.prompt_cache_key,
    headers?.["x-session-id"],
    headers?.["x-conversation-id"],
    headers?.["x-thread-id"],
  ]
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function rememberReply(text, cid, sessionKey) {
  if (!text || !cid) return
  REPLY_INDEX.set(quickHash(text), cid)
  if (sessionKey) REPLY_INDEX.set("k:" + sessionKey, cid)
  while (REPLY_INDEX.size > REPLY_LIMIT) REPLY_INDEX.delete(REPLY_INDEX.keys().next().value)
}

// 图片：OpenAI 传的是 data URL，zulu 要文件路径，落一份临时文件，用完就删。
function imageDir() {
  const d = join(selfDir(), ".tmp")
  try {
    mkdirSync(d, { recursive: true })
  } catch {}
  return d
}

function extractImages(message) {
  const out = []
  if (!Array.isArray(message?.content)) return out
  for (const part of message.content) {
    if (part?.type !== "image_url") continue
    const url = part?.image_url?.url ?? ""
    const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(url)
    if (!m) continue
    const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z0-9]/gi, "") || "png"
    const file = join(imageDir(), `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    try {
      writeFileSync(file, Buffer.from(m[2], "base64"))
      out.push(file)
    } catch {}
  }
  return out
}

function dropImages(files) {
  for (const f of files) {
    try {
      unlinkSync(f)
    } catch {}
  }
}

// 起本地 OpenAI 兼容口。端口固定，已被占用就认为别的 magpie 进程已经在服务了。
let proxyReady = null
function startProxy() {
  if (proxyReady) return proxyReady
  proxyReady = new Promise((done) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const send = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        res.end(JSON.stringify(body))
      }

      if (url.pathname.endsWith("/models") && req.method === "GET") {
        return send(200, {
          object: "list",
          data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: PROVIDER_ID })),
        })
      }

      if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
        const body = await readJsonBody(req)
        const model = modelOf(body.model)
        const msgs = Array.isArray(body.messages) ? body.messages : []
        const lastUser = [...msgs].reverse().find((m) => m?.role === "user")
        const images = extractImages(lastUser)
        // 续会话只发最后一句（历史在 zulu 那边），新会话才把 system + 历史拼成一条
        const sessionKey = explicitSession(body, req.headers)
        const cid = findCid(msgs, sessionKey)
        const query = cid && lastUser ? textOf(lastUser) : toQuery(msgs)
        if (!query) {
          dropImages(images)
          return send(400, { error: { message: "messages 是空的", type: "invalid_request_error" } })
        }
        try {
          const { text, cid: newCid } = await runZulu(query, model.label, { cid, images })
          rememberReply(text, newCid, sessionKey)
          dropImages(images)
          const id = "chatcmpl-" + Date.now().toString(36)
          const created = Math.floor(Date.now() / 1000)
          if (body.stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              Connection: "keep-alive",
            })
            const chunk = (delta, finish = null) =>
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: model.id,
                choices: [{ index: 0, delta, finish_reason: finish }],
              })}\n\n`
            res.write(chunk({ role: "assistant", content: text }))
            res.write(chunk({}, "stop"))
            res.write("data: [DONE]\n\n")
            return res.end()
          }
          return send(200, {
            id,
            object: "chat.completion",
            created,
            model: model.id,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
        } catch (e) {
          dropImages(images)
          return send(502, { error: { message: String(e?.message ?? e), type: "upstream_error" } })
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("not found")
    })

    server.once("error", (e) => {
      if (e?.code === "EADDRINUSE") return done(`http://127.0.0.1:${PROXY_PORT}/v1`) // 已有进程在服务
      done("")
    })
    server.listen(PROXY_PORT, "127.0.0.1", () => done(`http://127.0.0.1:${PROXY_PORT}/v1`))
  })
  return proxyReady
}

export const ComatePlugin = async ({ client, magpie } = {}, options = {}) => {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "comate-auth", level: "info", message } })
    } catch {}
  }
  // 插件自己的 OpenAI 兼容口（起不来就只当额度卡片，不影响登录）
  const localBase = await startProxy().catch(() => "")
  if (localBase) log(`Comate: 模型通道在 ${localBase}`)

  const cookiesOf = (auth) => {
    if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
      throw signInError("文心快码未登录，请先在 magpie 登录")
    }
    return auth.cookies
  }

  const makeAuth = (cookies, info, source) => ({
    type: "success",
    access: "cookie:" + buildCookieHeader(cookies),
    refresh: "",
    expires: 0,
    source,
    accountId: String(info?.license ?? info?.username ?? PROVIDER_NAME),
    name: String(info?.displayName ?? info?.username ?? ""),
    cookies,
  })

  // 用一份 cookie 直接问 Comate 本人是谁；顺带把死会话挡在登录这一步。
  const verify = async (cookies) => {
    const header = buildCookieHeader(cookies)
    try {
      const info = await getJson("/api/user", header)
      if (info && (info.username || info.license)) return info
    } catch {}
    // /api/user 偶尔被限流，balance 能通就说明这份登录态是活的。
    const bal = await getJson("/api/user/agent/balance", header)
    if (!bal) throw signInError("Cookie 未换到 Comate 账号信息")
    return { username: "", license: "" }
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER_ID] ?? {}
      const base = localBase || was.api
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        ...(base ? { api: base } : {}),
        ...was,
        models: {
          ...Object.fromEntries(MODELS.map((m) => modelEntry(m, base))),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        const base = localBase || provider?.api
        return Object.fromEntries(MODELS.map((m) => modelEntry(m, base)))
      },
    },

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      // 登录态是两个 httpOnly cookie，没有 refresh 流。这里只在「复用本机」来源时
      // 跟着 magpie 里 DuMate 的登录态走：那边重登了，这边自动换新的。
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source !== "magpie") return undefined
        const d = readMagpieCookies()
        if (!d) return undefined
        const oldHeader = buildCookieHeader(auth.cookies ?? [])
        const newHeader = buildCookieHeader(d.cookies)
        if (newHeader === oldHeader) return undefined
        try {
          const info = await verify(d.cookies)
          return makeAuth(d.cookies, info, "magpie")
        } catch {
          return undefined
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: "expired" }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { error: "没有登录信息，请先在 magpie 登录文心快码", signIn: "kept" }
        }
        const header = buildCookieHeader(auth.cookies)
        const cacheKey = header
        let cached = usageCache.get(cacheKey)
        if (!cached) {
          const disk = readDiskCache()
          if (disk) {
            cached = disk
            usageCache.set(cacheKey, disk)
          }
        }
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
        try {
          // 只打一个接口：Comate 对同一登录态的短时间连发很敏感，请求越少越稳，
          // 卡片上要的席位/增购/赠送/独立包都在 balance 里。
          const bal = await getJson("/api/user/agent/balance", header)
          if (!bal) throw new Error("Comate 积分接口不可用")

          const seat = packOf(bal.seatPoints)
          const add = packOf(bal.addonPoints)
          const gft = packOf(bal.giftPoints)
          const standalone = packOf(bal.standalonePackPoints)

          const groups = [
            { name: "席位积分", p: seat },
            { name: "增购积分", p: add },
            { name: "赠送积分", p: gft },
            { name: "独立积分包", p: standalone },
          ].filter((g) => g.p.total > 0)

          const availAll = groups.reduce((s, g) => s + g.p.available, 0)

          // 席位积分每月自动补满，下期发放时间在 seatPointsNextUpdate。
          // 日期按接口原串显示，别经 Date 转 UTC。
          const nextSeatRaw = String(bal.seatPointsNextUpdate ?? "")
          const nextSeat = parseCnTime(nextSeatRaw)
          const isMember = seat.total > 0
          const planBits = [isMember ? `会员 · 席位 ${Math.round(seat.total).toLocaleString("en-US")} 分/月` : "Free"]
          if (nextSeat) planBits.push(`下期 ${nextSeatRaw.slice(5, 10)} 补满`)

          const data = {
            plan: planBits.join(" · "),
            balance: `${availAll.toFixed(2)} 积分`,
            windows: groups.map((g) => ({
              name: g.name,
              used: g.p.total > 0 ? (100 * g.p.used) / g.p.total : 0,
              display: `${g.p.used.toFixed(2)} / ${g.p.total.toFixed(2)}`,
              amount: g.p.used,
              limit: g.p.total,
              unit: "points",
            })),
            user: auth.name || auth.accountId || PROVIDER_NAME,
            signIn: "kept",
          }
          usageCache.set(cacheKey, { at: Date.now(), data })
          writeDiskCache(data)
          return data
        } catch (e) {
          const expired = e?.signIn === "expired"
          // 被 Comate 临时拒了（短时间内请求过多会这样）：有旧数据就先给旧的，
          // 卡片不至于空着，下次刷新再拿新的。
          if (cached) return { ...cached.data, error: cardText(e?.message) || "Comate 暂时拒绝请求，显示的是上次数据" }
          return { error: cardText(e?.message) || "Comate 用量查询失败", signIn: expired ? "expired" : "kept" }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "复用 magpie 里已登录的百度账号（零操作）",
          authorize: async () => ({
            url: "",
            instructions:
              "直接复用 magpie 里已登录的百度账号（文心快码与百度搭子共用同一个百度登录态）：只读本机 magpie 的凭据文件，不写任何东西。\n" +
              "如果 magpie 里还没有登录过百度搭子，请改用下面的浏览器登录方式。",
            method: "auto",
            async callback() {
              const d = readMagpieCookies()
              if (!d) {
                return {
                  type: "failed",
                  error: "没找到可复用的百度登录态（magpie 里没有已登录的 DuMate/Comate 账号）。请改用浏览器登录方式。",
                }
              }
              try {
                const info = await verify(d.cookies)
                return makeAuth(d.cookies, info, "magpie")
              } catch (e) {
                return { type: "failed", error: `复用失败：${e?.message ?? e}` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（粘贴 Cookie）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 点击上方链接，在浏览器登录你的百度账号（登录成功会跳到 comate.baidu.com 个人中心）。\n" +
              "2. 打开 https://comate.baidu.com/zh/user ，按 F12 → Network（网络），刷新页面，点第一个 comate.baidu.com 的请求。\n" +
              "3. 在 Request Headers（请求标头）里找到 Cookie 一行，右键 → Copy value（复制值），粘贴到下方。\n" +
              "（关键登录 Cookie 是 httpOnly，控制台 document.cookie 拿不到，必须从 Network 面板复制）",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim().replace(/^[\"']|[\"']$/g, "")
              if (!raw || !raw.includes("=")) return { type: "failed", error: "请粘贴请求头中 Cookie 行的完整值" }
              const cookies = parseCookieString(raw)
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) {
                return {
                  type: "failed",
                  error: `Cookie 缺少关键字段：${missing.join(", ")}。请确认复制的是 comate.baidu.com 请求头里的 Cookie（不是 document.cookie）`,
                }
              }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "browser")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}。请重新登录并复制新的 Cookie` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          authorize: async () => ({
            url: "",
            instructions: "粘贴完整的 Cookie 字符串（name=value; name2=value2 格式，必须包含 BDUSS，来自 comate.baidu.com 的请求头）：",
            method: "code",
            async callback(input) {
              const cookies = parseCookieString(String(input ?? "").trim())
              if (cookies.length < 2) return { type: "failed", error: "无法解析 Cookie 字符串" }
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}` }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "manual")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}` }
              }
            },
          }),
        },
      ],
    },
  }
}

export default ComatePlugin

// 单元测试用的纯函数（不联网）。
export const _internal = {
  parseCookieString,
  buildCookieHeader,
  missingCookies,
  packOf,
  parseCnTime,
}