const baseUrlEl = document.getElementById("baseUrl");
const apiKeyEl = document.getElementById("apiKey");
const modelPresetEl = document.getElementById("modelPreset");
const refreshModelsBtn = document.getElementById("refreshModels");
const modelStatusEl = document.getElementById("modelStatus");
const groupBtn = document.getElementById("groupBtn");
const ungroupBtn = document.getElementById("ungroupBtn");
const statusEl = document.getElementById("status");
const modelDetailsEl = document.getElementById("modelDetails");
const reasoningLabelEl = document.getElementById("reasoningLabel");
const reasoningEl = document.getElementById("reasoning");
const modelOutputEl = document.getElementById("modelOutput");
const logDetailsEl = document.getElementById("logDetails");
const logsEl = document.getElementById("logs");
const copyLogsBtn = document.getElementById("copyLogs");
const copyStatusEl = document.getElementById("copyStatus");
let windowId;
let savedModel = "";
let modelRequest;
let busy = true;

function readSettings() {
  return {
    baseUrl: baseUrlEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
    model: savedModel
  };
}

function updateModelControls() {
  groupBtn.disabled = busy || !modelPresetEl.value;
  ungroupBtn.disabled = busy;
  modelPresetEl.disabled = busy || modelPresetEl.options.length < 2;
  refreshModelsBtn.disabled = busy || Boolean(modelRequest) || !baseUrlEl.value.trim() || !apiKeyEl.value.trim();
  refreshModelsBtn.textContent = modelRequest ? "正在获取…" : "刷新可用模型";
}

function showStatus({ text = "", busy: taskBusy = false, showModel, output, reasoning, summary, logs, failed } = {}) {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  busy = taskBusy;
  updateModelControls();

  modelDetailsEl.hidden = !showModel;
  reasoningLabelEl.textContent = summary && !reasoning ? "分组依据 · 模型摘要" : "模型思考";
  const thought = reasoning || summary || (busy ? "等待模型返回…" : "接口未返回思考内容或摘要。");
  if (reasoningEl.textContent !== thought) reasoningEl.textContent = thought;
  const modelOutput = output || (busy ? "等待模型输出…" : "没有收到模型输出。");
  if (modelOutputEl.textContent !== modelOutput) modelOutputEl.textContent = modelOutput;
  const logText = (logs || []).join("\n");
  if (logsEl.textContent !== logText) {
    logsEl.textContent = logText;
    copyStatusEl.textContent = "";
  }
  logDetailsEl.hidden = !logText;
  if (failed) logDetailsEl.open = true;
}

function fillModelOptions(models, placeholder = "请选择模型") {
  modelPresetEl.replaceChildren(
    Object.assign(new Option(placeholder, ""), { disabled: true }),
    ...models.map((id) => new Option(id, id))
  );
  modelPresetEl.value = models.includes(savedModel) ? savedModel : "";
  updateModelControls();
}

async function refreshModels() {
  const { baseUrl, apiKey } = readSettings();
  if (!baseUrl || !apiKey) {
    fillModelOptions([], "请先填写 API 配置");
    return;
  }

  const request = new AbortController();
  modelRequest = request;
  fillModelOptions([], "正在获取模型…");
  modelStatusEl.textContent = "";
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { data } = await response.json();
    if (!Array.isArray(data)) throw new Error("接口未返回有效的模型列表");
    const models = [...new Set(data.map((model) => model?.id).filter((id) => typeof id === "string" && id.trim()))];
    if (modelRequest !== request) return;
    if (!models.length) {
      fillModelOptions([], "暂无可用模型");
      return;
    }
    fillModelOptions(models);
    modelStatusEl.textContent = savedModel && !models.includes(savedModel)
      ? `已获取 ${models.length} 个模型，请重新选择。`
      : `已获取 ${models.length} 个模型。`;
  } catch (err) {
    if (modelRequest !== request) return;
    fillModelOptions([], "未能获取模型");
    const reason = err.name === "TimeoutError" ? "请求超过 15 秒" : err.message.replaceAll(apiKey, "[已隐藏]");
    modelStatusEl.textContent = `获取失败：${reason}`;
  } finally {
    if (modelRequest === request) {
      modelRequest = undefined;
      updateModelControls();
    }
  }
}

async function initialize() {
  showStatus({ busy: true });
  try {
    const [settings, window] = await Promise.all([
      chrome.storage.local.get(["baseUrl", "apiKey", "model"]),
      chrome.windows.getCurrent()
    ]);
    baseUrlEl.value = settings.baseUrl ?? "https://api.openai.com/v1";
    apiKeyEl.value = settings.apiKey || "";
    savedModel = settings.model || "";
    windowId = window.id;

    const statusKey = `status:${windowId}`;
    let receivedUpdate = false;
    chrome.storage.session.onChanged.addListener((changes) => {
      if (!changes[statusKey]) return;
      receivedUpdate = true;
      showStatus(changes[statusKey].newValue);
    });
    const status = await chrome.runtime.sendMessage({ action: "status", windowId });
    if (!receivedUpdate) showStatus(status || undefined);
    refreshModels();
  } catch (err) {
    showStatus({ text: `无法读取扩展状态：${err.message}`, busy: true });
  }
}

for (const input of [baseUrlEl, apiKeyEl]) {
  input.addEventListener("input", () => {
    modelRequest?.abort();
    modelRequest = undefined;
    fillModelOptions([], "请刷新可用模型");
    modelStatusEl.textContent = "";
    chrome.storage.local.set(readSettings());
  });
}
modelPresetEl.addEventListener("change", () => {
  savedModel = modelPresetEl.value;
  updateModelControls();
  chrome.storage.local.set(readSettings());
});
refreshModelsBtn.addEventListener("click", refreshModels);

copyLogsBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(logsEl.textContent);
    copyStatusEl.textContent = "已复制";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(logsEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatusEl.textContent = "日志已选中，可手动复制";
  }
});

async function start(action, settings) {
  showStatus({ text: "正在启动任务...", busy: true });
  try {
    await chrome.runtime.sendMessage({ action, windowId, settings });
  } catch (err) {
    showStatus({ text: `无法启动任务：${err.message}` });
  }
}

groupBtn.addEventListener("click", () => {
  if (!modelPresetEl.value) return;
  const settings = readSettings();
  settings.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  start("group", settings);
});

ungroupBtn.addEventListener("click", () => start("ungroup"));
initialize();
