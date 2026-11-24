const VALID_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const MODEL_TIMEOUT_MS = 90_000;
const PREVIEW_LIMIT = 24_000;
const runningWindows = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.url !== chrome.runtime.getURL("popup.html")) return;

  const { action, windowId } = message;
  if (action === "status") {
    const key = `status:${windowId}`;
    chrome.storage.session.get(key).then((stored) => {
      const status = stored[key];
      sendResponse(status?.busy && !runningWindows.has(windowId)
        ? {
            ...status,
            busy: false,
            text: "上次任务已中断，请重试。",
            logs: [...(status.logs || []), "后台任务中断。"]
          }
        : status);
    });
    return true;
  }

  if (action !== "group" && action !== "ungroup") return;
  if (!runningWindows.has(windowId)) {
    runningWindows.add(windowId);
    run(action, windowId, message.settings);
  }
  sendResponse({});
});

async function run(action, windowId, settings) {
  const key = `status:${windowId}`;
  const started = performance.now();
  const state = { busy: true, text: "正在读取当前窗口标签页...", logs: [], showModel: action === "group" };
  let pendingUpdate;

  function publish() {
    clearTimeout(pendingUpdate);
    pendingUpdate = undefined;
    return chrome.storage.session.set({ [key]: state });
  }

  function update(changes, log) {
    Object.assign(state, changes);
    if (log) state.logs.push(`+${((performance.now() - started) / 1000).toFixed(2)}s ${log}`);
    pendingUpdate ??= setTimeout(() => publish().catch(console.error), 200);
  }

  let result;
  try {
    update({}, action === "group" ? "开始智能分组。" : "开始解散分组。");
    await publish();
    const tabs = await chrome.tabs.query({ windowId, pinned: false });
    update({}, `读取到 ${tabs.length} 个未固定标签页。`);
    if (action === "ungroup") {
      const ids = tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
      result = ids.length ? `已解散 ${ids.length} 个标签页的分组。` : "当前没有已分组的标签页。";
    } else if (tabs.length < 2) {
      result = "标签页少于 2 个，无需分组。";
    } else {
      const model = settings.model.replaceAll(settings.apiKey, "[已隐藏]");
      update({ text: `正在调用 ${model} 分析 ${tabs.length} 个标签页...` }, `模型 ${model}。`);
      result = await groupTabs(tabs, windowId, settings, update);
    }
  } catch (err) {
    result = err.name === "TimeoutError"
      ? `等待模型响应超过 ${MODEL_TIMEOUT_MS / 1000} 秒，请重试。`
      : `失败：${err.message}`;
    const error = err.name === "TimeoutError" ? result : (err.diagnostic || err.name);
    update({ failed: true }, `任务失败（${error}）。`);
  }
  if (!state.failed) update({}, result);
  runningWindows.delete(windowId);
  update({ text: result, busy: false });
  await publish();
}

function modelError(message, diagnostic) {
  return Object.assign(new Error(message), { diagnostic });
}

async function* streamEvents(body) {
  let buffer = "";
  let lines = [];
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.search(/[\r\n]/)) !== -1) {
      if (buffer[end] === "\r" && end === buffer.length - 1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
      if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
      if (line === "") {
        if (lines.length) yield lines.join("\n");
        lines = [];
      }
    }
  }
  if (buffer.startsWith("data:")) lines.push(buffer.slice(5).replace(/^ /, "").trimEnd());
  if (lines.length) yield lines.join("\n");
}

async function readModelStream(body, addText, update) {
  let events = 0;
  let finished = false;
  let finishReason;
  for await (const data of streamEvents(body)) {
    if (data.trim() === "[DONE]") {
      finished = true;
      break;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw modelError("模型返回了无法解析的流式事件。", "流式事件 JSON 无效");
    }
    events++;
    if (events === 1) update({ text: "正在接收模型响应..." }, "收到首个流式事件。");
    if (event?.error) throw modelError("模型在流式响应中返回错误。", "流式接口报错");
    const choice = event?.choices?.[0];
    finishReason = choice?.finish_reason || finishReason;
    addText(choice?.delta);
  }
  update({}, `流式响应结束，共 ${events} 个事件。`);
  if (!finished && !finishReason) throw modelError("流式响应在结束前断开。", "流式响应中断");
  return finishReason;
}

async function requestModel({ baseUrl, apiKey, model }, prompt, update) {
  // Keep the worker alive only while the model request is running.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  let output = "";
  let reasoning = "";
  const preview = (text) => {
    const safe = text.replaceAll(apiKey, "[已隐藏]");
    return safe.length > PREVIEW_LIMIT ? `${safe.slice(0, PREVIEW_LIMIT)}\n…（显示已截断）` : safe;
  };

  function addText(message) {
    const thought = message?.reasoning_content ?? message?.reasoning;
    if (typeof message?.content === "string") output += message.content;
    if (typeof thought === "string") reasoning += thought;
    if (message?.content || thought) update({ output: preview(output), reasoning: preview(reasoning) });
  }

  async function send(stream) {
    update({}, `POST /chat/completions（${stream ? "流式" : "普通"}）。`);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal,
      body: JSON.stringify({ model, stream, temperature: 0.2, messages: [{ role: "user", content: prompt }] })
    });
    const requestId = response.headers.get("x-request-id");
    const reference = requestId && /^[\w.:-]{1,128}$/.test(requestId) && !requestId.includes(apiKey)
      ? ` · Request ID ${requestId}` : "";
    update({}, `收到 HTTP ${response.status}${reference}。`);
    return response;
  }

  async function requireSuccess(response) {
    const text = (await response.text()).replaceAll(apiKey, "[已隐藏]");
    throw modelError(`HTTP ${response.status}: ${text.slice(0, 150)}`, `HTTP ${response.status}`);
  }

  try {
    let response = await send(true);
    if (!response.ok) {
      const rejectedStream = [400, 422, 501].includes(response.status)
        && /(?:stream(?:ing)?[^.\n]{0,50}(?:unsupported|not supported|not implemented|must be false)|(?:unsupported|does not support)[^.\n]{0,50}stream(?:ing)?|不支持.{0,20}流式)/i.test(await response.clone().text());
      if (!rejectedStream) await requireSuccess(response);
      await response.body?.cancel();
      update({}, "接口拒绝流式参数，改用普通请求。");
      response = await send(false);
      if (!response.ok) await requireSuccess(response);
    }

    let finishReason;
    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      update({}, "响应格式为 SSE，等待首段数据。");
      finishReason = await readModelStream(response.body, addText, update);
    } else {
      update({}, "响应格式为普通 JSON。");
      let data;
      try {
        data = await response.json();
      } catch (err) {
        if (err.name !== "SyntaxError") throw err;
        throw modelError("接口返回的内容不是有效 JSON。", "响应 JSON 无效");
      }
      if (data?.error) throw modelError("模型接口返回错误。", "普通接口报错");
      const choice = data?.choices?.[0];
      addText(choice?.message);
      finishReason = choice?.finish_reason;
    }
    if (finishReason === "length") throw modelError("模型输出因长度限制被截断。", "达到输出长度上限");
    update({}, `收到完整输出 · 正文 ${output.length} 字符 · 思考 ${reasoning.length} 字符。`);
    return output;
  } finally {
    clearInterval(keepAlive);
  }
}

async function groupTabs(tabs, windowId, settings, update) {
  const tabData = tabs.map((tab) => ({
    id: tab.id,
    title: (tab.title || "").slice(0, 80),
    url: (tab.url || "").slice(0, 120)
  }));

  const prompt = `你是一个浏览器标签页整理助手。请将以下标签页按主题或用途归类为 2 到 6 个简洁的中文分组（每组名不超过 6 个字）。
只返回纯 JSON，不要包含任何解释或 Markdown 标记，格式如下：
{
  "groups": [
    {
      "name": "分组名称",
      "color": "从 ${VALID_COLORS.join(", ")} 中选一个",
      "tabIds": [标签id数字数组]
    }
  ],
  "summary": "用一句话概括分组依据，不复述标签页内容"
}
规则：
1. 每个 tabId 只能出现一次。
2. 实在无法归类的单个孤立标签页可以省略（不放入任何组）。

标签页列表：
${JSON.stringify(tabData)}`;

  const content = await requestModel(settings, prompt, update);
  let parsed;
  try {
    const json = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
    parsed = JSON.parse(json);
  } catch {
    throw modelError("模型没有返回可解析的分组 JSON。", "分组 JSON 无效");
  }
  if (!Array.isArray(parsed?.groups)) throw modelError("模型返回的分组格式不正确。", "缺少 groups 数组");
  const summary = typeof parsed.summary === "string"
    ? parsed.summary.replaceAll(settings.apiKey, "[已隐藏]").slice(0, 600) : "";
  update({ summary, text: "正在创建标签组..." }, `解析出 ${parsed.groups.length} 个候选分组。`);

  const currentTabs = await chrome.tabs.query({ windowId, pinned: false });
  const currentIds = new Set(currentTabs.map((tab) => tab.id));
  const remainingIds = new Set(tabs.map((tab) => tab.id).filter((id) => currentIds.has(id)));
  let createdCount = 0;

  for (const group of parsed.groups) {
    if (!Array.isArray(group?.tabIds)) continue;
    const ids = group.tabIds.filter((id) => remainingIds.delete(id));
    if (!ids.length) continue;

    try {
      const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: typeof group.name === "string" && group.name ? group.name : "未命名",
        color: VALID_COLORS.includes(group.color) ? group.color : "blue"
      });
    } catch (err) {
      throw modelError(err.message, `Chrome 创建分组失败，已完成 ${createdCount} 组`);
    }
    createdCount++;
  }

  return createdCount ? `完成！已创建 ${createdCount} 个分组。` : "没有可创建的分组。";
}
