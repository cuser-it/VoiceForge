const DEFAULT_SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.018;
const SILENCE_STOP_MS = 3200;
const MIN_RECORD_MS = 650;

const state = {
  builtinTexts: [],
  customTexts: [],
  sourceMode: "builtin",
  taskCount: 20,
  sampleRate: DEFAULT_SAMPLE_RATE,
  audioInputDeviceId: "",
  audioInputDevices: [],
  isAudioDeviceMenuOpen: false,
  isTaskPanelCollapsed: false,
  tasks: [],
  currentIndex: 0,
  status: "ready",
  savedRecords: [],
  sessionStack: [],
  totalSavedDuration: 0,
  tempRecording: null,
  sequence: 1,
  outputHandle: null,
  audioDirHandle: null,
  jsonlHandle: null,
  metadataHandle: null,
  baseJsonlLines: [],
  baseMetadataRows: [],
  jsonlLines: [],
  metadataLines: ["file,text,duration,index,created_at"],
  recorder: null,
};

const els = {
  poolSummary: document.querySelector("#poolSummary"),
  storageMode: document.querySelector("#storageMode"),
  countOptions: document.querySelector("#countOptions"),
  sampleRateOptions: document.querySelector("#sampleRateOptions"),
  audioInputButton: document.querySelector("#audioInputButton"),
  audioInputLabel: document.querySelector("#audioInputLabel"),
  audioDeviceMenu: document.querySelector("#audioDeviceMenu"),
  refreshDevicesButton: document.querySelector("#refreshDevicesButton"),
  sourceOptions: document.querySelector("#sourceOptions"),
  sourcePanel: document.querySelector("#sourcePanel"),
  sourcePanelClose: document.querySelector("#sourcePanelClose"),
  sourcePanelToggle: document.querySelector("#sourcePanelToggle"),
  taskPanel: document.querySelector(".task-panel"),
  taskPanelClose: document.querySelector("#taskPanelClose"),
  taskPanelToggle: document.querySelector("#taskPanelToggle"),
  customFile: document.querySelector("#customFile"),
  customSummary: document.querySelector("#customSummary"),
  shuffleButton: document.querySelector("#shuffleButton"),
  shuffleButtonMirror: document.querySelector("#shuffleButtonMirror"),
  resetButton: document.querySelector("#resetButton"),
  directoryButton: document.querySelector("#directoryButton"),
  exportButton: document.querySelector("#exportButton"),
  outputSummary: document.querySelector("#outputSummary"),
  statusStrip: document.querySelector("#statusStrip"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  vocalAura: document.querySelector("#vocalAura"),
  promptMeta: document.querySelector("#promptMeta"),
  progressText: document.querySelector("#progressText"),
  promptProgressFill: document.querySelector("#promptProgressFill"),
  nextPromptText: document.querySelector("#nextPromptText"),
  durationText: document.querySelector("#durationText"),
  promptText: document.querySelector("#promptText"),
  recordLed: document.querySelector("#recordLed"),
  timer: document.querySelector("#timer"),
  waveform: document.querySelector("#waveform"),
  playback: document.querySelector("#playback"),
  recordButton: document.querySelector("#recordButton"),
  saveButton: document.querySelector("#saveButton"),
  undoButton: document.querySelector("#undoButton"),
  taskList: document.querySelector("#taskList"),
  listSummary: document.querySelector("#listSummary"),
  completionBadge: document.querySelector("#completionBadge"),
  progressFill: document.querySelector("#progressFill"),
  toastRegion: document.querySelector("#toastRegion"),
  shaderCanvas: document.querySelector("#shaderCanvas"),
};

const canvasContext = els.waveform.getContext("2d");

class TextProvider {
  async load() {
    return [];
  }
}

class BuiltinProvider extends TextProvider {
  async load() {
    const response = await fetch("./data/text_pool.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("无法载入内置文案库");
    }

    const data = await response.json();
    return normalizeTexts(data);
  }
}

class CustomFileProvider extends TextProvider {
  constructor(file) {
    super();
    this.file = file;
  }

  async load() {
    const raw = await this.file.text();
    const lowerName = this.file.name.toLowerCase();
    if (lowerName.endsWith(".csv")) {
      return normalizeTexts(parseCsvSingleColumn(raw));
    }
    return normalizeTexts(raw.split(/\r?\n/));
  }
}

class BrowserRecorder {
  constructor({ canvas, onLevel, onStop, onDeviceReady, deviceId }) {
    this.canvas = canvas;
    this.onLevel = onLevel;
    this.onStop = onStop;
    this.onDeviceReady = onDeviceReady;
    this.deviceId = deviceId;
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.analyser = null;
    this.chunks = [];
    this.waveData = null;
    this.animationId = null;
    this.startedAt = 0;
    this.lastVoiceAt = 0;
    this.hasVoice = false;
    this.isRecording = false;
  }

  async start() {
    await this.stopTracks();
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (this.deviceId) {
      audioConstraints.deviceId = { exact: this.deviceId };
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
    const track = this.stream.getAudioTracks()[0];
    this.onDeviceReady?.({
      deviceId: track?.getSettings?.().deviceId || this.deviceId || "",
      label: track?.label || "",
    });

    this.audioContext = new AudioContext();
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.waveData = new Float32Array(this.analyser.fftSize);
    this.chunks = [];
    this.startedAt = performance.now();
    this.lastVoiceAt = this.startedAt;
    this.hasVoice = false;
    this.isRecording = true;

    this.processor.onaudioprocess = (event) => {
      if (!this.isRecording) return;

      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
      const rms = calculateRms(input);
      const now = performance.now();
      if (rms > SILENCE_THRESHOLD) {
        this.hasVoice = true;
        this.lastVoiceAt = now;
      }

      this.onLevel(rms);
      const hasMinimumDuration = now - this.startedAt >= MIN_RECORD_MS;
      const silentForLongEnough = now - this.lastVoiceAt >= SILENCE_STOP_MS;
      if (this.hasVoice && hasMinimumDuration && silentForLongEnough) {
        this.stop("vad");
      }
    };

    this.source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.draw();
  }

  async stop(reason = "manual") {
    if (!this.isRecording) return null;
    this.isRecording = false;
    cancelAnimationFrame(this.animationId);
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.analyser) this.analyser.disconnect();
    if (this.source) this.source.disconnect();

    const sampleRate = this.audioContext.sampleRate;
    const samples = mergeAudioChunks(this.chunks);
    const outputRate = state.sampleRate;
    const resampled = resampleLinear(samples, sampleRate, outputRate);
    const duration = resampled.length / outputRate;
    const wavBlob = encodeWav(resampled, outputRate);
    await this.stopTracks();
    await this.closeContext();

    this.onLevel(0);
    this.onStop({
      blob: wavBlob,
      samples: resampled,
      duration,
      reason,
      url: URL.createObjectURL(wavBlob),
    });
    return wavBlob;
  }

  draw() {
    if (!this.isRecording || !this.analyser) return;

    this.analyser.getFloatTimeDomainData(this.waveData);
    drawWaveform(this.waveData);
    this.animationId = requestAnimationFrame(() => this.draw());
  }

  async stopTracks() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  async closeContext() {
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.audioContext = null;
  }
}

async function init() {
  bindEvents();
  prepareCanvas();
  initShaderBackground();
  drawWaveform(new Float32Array(2048));
  updateDirectorySupport();
  await refreshAudioInputDevices();

  try {
    state.builtinTexts = await new BuiltinProvider().load();
    if (state.builtinTexts.length < 300) {
      showToast(`内置文案当前为 ${state.builtinTexts.length} 条，请检查 text_pool.json`);
    }
    shuffleTasks();
    renderAll();
  } catch (error) {
    console.error(error);
    setStatus("ready", "内置文案载入失败，请检查 data/text_pool.json");
    els.promptText.textContent = "无法载入文案库";
  }
}

function bindEvents() {
  els.countOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-count]");
    if (!button) return;
    setTaskCount(Number(button.dataset.count));
  });

  els.sampleRateOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sample-rate]");
    if (!button) return;
    setSampleRate(Number(button.dataset.sampleRate));
  });
  els.audioInputButton?.addEventListener("click", () => {
    toggleAudioDeviceMenu();
  });
  els.audioDeviceMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-device-id]");
    if (!button) return;
    setAudioInputDevice(button.dataset.deviceId);
    closeAudioDeviceMenu();
  });
  els.refreshDevicesButton?.addEventListener("click", () => {
    refreshAudioInputDevices({ requestPermission: true });
  });
  document.addEventListener("click", (event) => {
    if (!state.isAudioDeviceMenuOpen) return;
    if (event.target.closest("#deviceControl")) return;
    closeAudioDeviceMenu();
  });
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshAudioInputDevices();
    });
  }

  els.sourceOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-source]");
    if (!button) return;
    setSourceMode(button.dataset.source);
  });
  els.sourcePanelClose?.addEventListener("click", () => setSourcePanelCollapsed(true));
  els.sourcePanelToggle?.addEventListener("click", () => setSourcePanelCollapsed(false));
  els.taskPanelClose?.addEventListener("click", () => setTaskPanelCollapsed(true));
  els.taskPanelToggle?.addEventListener("click", () => setTaskPanelCollapsed(false));

  els.customFile.addEventListener("change", handleCustomFile);
  els.shuffleButton.addEventListener("click", shuffleTasks);
  els.shuffleButtonMirror?.addEventListener("click", shuffleTasks);
  els.resetButton.addEventListener("click", () => {
    resetSession();
  });
  els.directoryButton.addEventListener("click", chooseOutputDirectory);
  els.exportButton.addEventListener("click", exportZip);
  els.recordButton.addEventListener("click", handleRecordButton);
  els.saveButton.addEventListener("click", saveCurrentRecording);
  els.undoButton.addEventListener("click", undoLastRecord);

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const tag = event.target.tagName.toLowerCase();
    const isTypingTarget = ["input", "textarea", "select"].includes(tag);
    if (isTypingTarget) return;
    const isDeviceControlTarget = Boolean(event.target.closest("#deviceControl"));

    if (event.code === "Escape" && state.isAudioDeviceMenuOpen) {
      event.preventDefault();
      closeAudioDeviceMenu();
      return;
    }

    if (event.code === "Space") {
      if (state.isAudioDeviceMenuOpen || isDeviceControlTarget) return;
      event.preventDefault();
      handleRecordButton();
    }

    if (event.code === "Enter") {
      if (state.isAudioDeviceMenuOpen || isDeviceControlTarget) return;
      event.preventDefault();
      saveCurrentRecording();
    }

    if (event.ctrlKey && event.code === "KeyZ") {
      event.preventDefault();
      undoLastRecord();
    }
  });
}

function setTaskCount(count) {
  if (state.status === "recording") return;
  state.taskCount = count;
  setActiveButton(els.countOptions, "[data-count]", String(count), "count");
  shuffleTasks();
}

function setSampleRate(sampleRate) {
  if (state.status === "recording") {
    showToast("录音中不能切换采样率");
    return;
  }
  state.sampleRate = sampleRate;
  setActiveButton(els.sampleRateOptions, "[data-sample-rate]", String(sampleRate), "sampleRate");
  showToast(`输出采样率已切换为 ${sampleRate / 1000}kHz`);
}

function setAudioInputDevice(deviceId) {
  if (state.status === "recording") {
    showToast("录音中不能切换麦克风");
    renderAudioInputDevices();
    return;
  }
  state.audioInputDeviceId = deviceId;
  renderAudioInputDevices();
  const deviceName = getAudioInputDeviceName(deviceId);
  showToast(`录音设备已切换为 ${deviceName}`);
}

async function refreshAudioInputDevices({ requestPermission = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    state.audioInputDevices = [];
    renderAudioInputDevices();
    return;
  }

  let permissionStream = null;
  try {
    if (requestPermission) {
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioInputDevices = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `麦克风 ${index + 1}`,
      }));

    const selectedStillExists =
      state.audioInputDeviceId &&
      state.audioInputDevices.some((device) => device.deviceId === state.audioInputDeviceId);
    if (!selectedStillExists && state.audioInputDeviceId) {
      state.audioInputDeviceId = "";
    }
    renderAudioInputDevices();
  } catch (error) {
    console.error(error);
    showToast("无法读取麦克风列表，请确认浏览器权限");
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

function renderAudioInputDevices() {
  const selectedValue = state.audioInputDeviceId;
  const selectedName = getAudioInputDeviceName(selectedValue);
  if (els.audioInputLabel) els.audioInputLabel.textContent = selectedName;
  if (els.audioInputButton) {
    els.audioInputButton.title = selectedName;
    els.audioInputButton.setAttribute("aria-expanded", String(state.isAudioDeviceMenuOpen));
  }
  if (!els.audioDeviceMenu) return;

  const items = [
    { deviceId: "", label: "默认麦克风" },
    ...state.audioInputDevices,
  ];
  els.audioDeviceMenu.replaceChildren(
    ...items.map((device) => {
      const button = document.createElement("button");
      const isSelected = device.deviceId === selectedValue;
      button.type = "button";
      button.className = "audio-device-option";
      button.dataset.deviceId = device.deviceId;
      button.role = "option";
      button.setAttribute("aria-selected", String(isSelected));
      button.classList.toggle("is-selected", isSelected);
      button.textContent = device.label;
      return button;
    }),
  );
}

function getAudioInputDeviceName(deviceId) {
  if (!deviceId) return "默认麦克风";
  return state.audioInputDevices.find((device) => device.deviceId === deviceId)?.label || "当前麦克风";
}

function toggleAudioDeviceMenu() {
  if (state.status === "recording") return;
  setAudioDeviceMenuOpen(!state.isAudioDeviceMenuOpen);
}

function closeAudioDeviceMenu() {
  setAudioDeviceMenuOpen(false);
}

function setAudioDeviceMenuOpen(open) {
  state.isAudioDeviceMenuOpen = open;
  if (els.audioDeviceMenu) els.audioDeviceMenu.hidden = !open;
  if (els.audioInputButton) {
    els.audioInputButton.classList.toggle("is-open", open);
    els.audioInputButton.setAttribute("aria-expanded", String(open));
  }
  if (open) positionAudioDeviceMenu();
}

function positionAudioDeviceMenu() {
  if (!els.audioDeviceMenu || !els.audioInputButton) return;
  els.audioDeviceMenu.classList.remove("is-left");
  const menuRect = els.audioDeviceMenu.getBoundingClientRect();
  const buttonRect = els.audioInputButton.getBoundingClientRect();
  const wouldOverflowRight = buttonRect.right + 8 + menuRect.width > window.innerWidth - 12;
  els.audioDeviceMenu.classList.toggle("is-left", wouldOverflowRight);
}

async function handleRecorderDeviceReady(device) {
  if (device?.deviceId) {
    state.audioInputDeviceId = device.deviceId;
  }
  await refreshAudioInputDevices();
  if (device?.deviceId) {
    state.audioInputDeviceId = device.deviceId;
    renderAudioInputDevices();
  }
}

function setSourceMode(mode) {
  if (state.status === "recording") return;
  state.sourceMode = mode;
  setActiveButton(els.sourceOptions, "[data-source]", mode, "source");
  if (mode === "combined" && state.customTexts.length === 0) {
    showToast("请上传 TXT 或 CSV 文案；当前仍使用内置文案");
  }
  shuffleTasks();
}

function setSourcePanelCollapsed(collapsed) {
  document.querySelector(".app-shell")?.classList.toggle("is-source-collapsed", collapsed);
  if (els.sourcePanel) {
    els.sourcePanel.hidden = collapsed;
  }
  if (els.sourcePanelToggle) {
    els.sourcePanelToggle.hidden = !collapsed;
  }
  window.setTimeout(() => {
    resizeCanvas();
    drawWaveform(state.tempRecording?.samples ?? new Float32Array(2048));
  }, 180);
}

function setTaskPanelCollapsed(collapsed) {
  state.isTaskPanelCollapsed = collapsed;
  document.querySelector(".app-shell")?.classList.toggle("is-task-collapsed", collapsed);
  if (els.taskPanel) {
    els.taskPanel.hidden = collapsed;
  }
  if (els.taskPanelToggle) {
    els.taskPanelToggle.hidden = !collapsed;
  }
  renderPromptMeta();
  window.setTimeout(() => {
    resizeCanvas();
    drawWaveform(state.tempRecording?.samples ?? new Float32Array(2048));
  }, 180);
}

async function handleCustomFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const provider = new CustomFileProvider(file);
    const texts = await provider.load();
    state.customTexts = texts;
    state.sourceMode = "combined";
    setActiveButton(els.sourceOptions, "[data-source]", "combined", "source");

    if (texts.length > 200) {
      showToast("建议不超过200条，过多文案可能影响录制效率");
    }

    showToast(`已载入 ${texts.length} 条自定义文案`);
    shuffleTasks();
  } catch (error) {
    console.error(error);
    showToast("自定义文案解析失败，请使用 TXT 或单列 CSV");
  } finally {
    event.target.value = "";
  }
}

function shuffleTasks() {
  if (state.status === "recording") return;
  const pool = getActivePool();
  if (pool.length === 0) return;

  state.tasks = sample(pool, Math.min(state.taskCount, pool.length)).map((text, index) => ({
    id: crypto.randomUUID(),
    text,
    displayIndex: index + 1,
    saved: false,
    fileName: null,
  }));
  state.currentIndex = 0;
  state.tempRecording = null;
  clearPlayback();
  setStatus("ready", "准备就绪，按 空格 开始");
  renderAll();
}

async function resetSession() {
  if (state.status === "recording") return;
  const sessionFiles = state.savedRecords.map((record) => record.fileName);
  state.savedRecords = [];
  state.sessionStack = [];
  state.totalSavedDuration = 0;
  state.tempRecording = null;
  state.sequence = nextSequenceFromRecords();
  rebuildManifestLines();
  try {
    await Promise.all(sessionFiles.map((fileName) => deleteSessionAudio(fileName)));
    await syncManifestFiles();
  } catch (error) {
    console.error(error);
    showToast("重置时清理本次会话文件失败，请检查输出目录权限");
  }
  shuffleTasks();
  showToast("已重新开始当前会话");
}

function getActivePool() {
  if (state.sourceMode === "combined") {
    return dedupeTexts([...state.builtinTexts, ...state.customTexts]);
  }
  return state.builtinTexts;
}

async function chooseOutputDirectory() {
  if (!("showDirectoryPicker" in window)) {
    showToast("当前浏览器不支持直接写入目录，请使用 ZIP 导出");
    return;
  }

  try {
    const root = await window.showDirectoryPicker({ mode: "readwrite" });
    const audioDir = await root.getDirectoryHandle("audio", { create: true });
    state.outputHandle = root;
    state.audioDirHandle = audioDir;
    state.jsonlHandle = await root.getFileHandle("train.jsonl", { create: true });
    state.metadataHandle = await root.getFileHandle("metadata.csv", { create: true });
    state.baseJsonlLines = await readExistingLines(state.jsonlHandle);
    state.baseMetadataRows = await readExistingMetadataRows(state.metadataHandle);
    const nextSequence = await nextSequenceFromDirectory(audioDir, state.baseJsonlLines);
    reassignSessionFiles(nextSequence);
    await writeSessionAudioFiles();
    rebuildManifestLines();
    await syncManifestFiles();
    updateDirectorySupport();
    showToast("已选择 output 目录，后续保存会直接写入磁盘");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      showToast("目录选择失败，请确认浏览器权限");
    }
  }
}

async function handleRecordButton() {
  if (state.status === "recording") {
    await stopRecording("manual");
    return;
  }

  if (isTaskComplete()) {
    showToast("当前任务已全部完成");
    return;
  }

  await startRecording();
}

async function startRecording() {
  try {
    clearPlayback();
    state.tempRecording = null;
    state.recorder = new BrowserRecorder({
      canvas: els.waveform,
      onLevel: updateLevel,
      onStop: handleRecordingStopped,
      onDeviceReady: handleRecorderDeviceReady,
      deviceId: state.audioInputDeviceId,
    });
    await state.recorder.start();
    setStatus("recording", "录音中...");
    els.saveButton.disabled = true;
    els.recordButton.classList.add("is-recording");
    els.recordLed.classList.add("is-recording");
    tickTimer();
  } catch (error) {
    console.error(error);
    setStatus("ready", "麦克风不可用，请检查浏览器授权");
    showToast("无法打开麦克风，请确认浏览器权限和设备连接");
  }
}

async function stopRecording(reason = "manual") {
  if (!state.recorder?.isRecording) return;
  await state.recorder.stop(reason);
}

function handleRecordingStopped(recording) {
  state.tempRecording = recording;
  state.status = "pending";
  els.playback.src = recording.url;
  els.saveButton.disabled = false;
  els.recordButton.classList.remove("is-recording");
  els.recordLed.classList.remove("is-recording");
  setStatus("pending", "录音完成，试听中... 按 回车 保存 / 按 空格 重录");
  updateTimer(recording.duration);
  drawWaveform(recording.samples);
  window.setTimeout(() => {
    if (state.tempRecording === recording) {
      els.playback.currentTime = 0;
      els.playback.play().catch(() => {});
    }
  }, 1000);
}

async function saveCurrentRecording() {
  if (!state.tempRecording || state.status === "recording" || isTaskComplete()) return;

  const task = state.tasks[state.currentIndex];
  const fileName = `sample_${String(state.sequence).padStart(3, "0")}.wav`;
  const audioPath = `audio/${fileName}`;
  const createdAt = new Date().toISOString();
  const duration = roundDuration(state.tempRecording.duration);
  const record = {
    taskId: task.id,
    taskIndex: state.currentIndex,
    fileName,
    audioPath,
    text: task.text,
    duration,
    blob: state.tempRecording.blob,
    createdAt,
    sequence: state.sequence,
  };

  if (state.audioDirHandle) {
    try {
      await writeFile(state.audioDirHandle, fileName, state.tempRecording.blob);
    } catch (error) {
      console.error(error);
      showToast("音频写入失败，请重新选择 output 目录");
      state.audioDirHandle = null;
      state.outputHandle = null;
      updateDirectorySupport();
      return;
    }
  }

  task.saved = true;
  task.fileName = fileName;
  state.savedRecords.push(record);
  state.sessionStack.push(record);
  state.totalSavedDuration += duration;
  state.sequence += 1;
  rebuildManifestLines();
  await syncManifestFiles();

  clearPlayback();
  state.tempRecording = null;
  state.currentIndex = Math.min(state.currentIndex + 1, state.tasks.length);
  setStatus("done", `第 ${state.savedRecords.length}/${state.tasks.length} 条 已完成`);
  renderAll();

  window.setTimeout(() => {
    if (state.status === "done") {
      setStatus("ready", isTaskComplete() ? "全部完成，请导出训练文件" : "准备就绪，按 空格 开始");
    }
  }, 800);
}

async function undoLastRecord() {
  if (state.status === "recording") return;
  const record = state.sessionStack.pop();
  if (!record) {
    showToast("无可撤销记录（仅本次会话可撤销）");
    return;
  }

  const savedIndex = state.savedRecords.findIndex((item) => item.sequence === record.sequence);
  if (savedIndex >= 0) {
    state.savedRecords.splice(savedIndex, 1);
  }

  const task = state.tasks[record.taskIndex];
  if (task) {
    task.saved = false;
    task.fileName = null;
    state.currentIndex = record.taskIndex;
  }

  state.totalSavedDuration = Math.max(0, state.totalSavedDuration - record.duration);
  state.tempRecording = null;
  clearPlayback();
  try {
    await deleteSessionAudio(record.fileName);
  } catch (error) {
    console.error(error);
    showToast("已撤销记录，但音频文件删除失败，请检查输出目录权限");
  }
  state.sequence = nextSequenceFromRecords();
  rebuildManifestLines();
  try {
    await syncManifestFiles();
  } catch (error) {
    console.error(error);
    showToast("撤销后清单同步失败，请检查输出目录权限");
  }
  showToast(`已撤销第 ${record.taskIndex + 1} 条（剩余 ${state.sessionStack.length} 条可撤销）`);
  setStatus("ready", "准备就绪，按 空格 开始");
  renderAll();
}

async function syncManifestFiles() {
  if (!state.outputHandle || !state.jsonlHandle || !state.metadataHandle) return;
  await writeHandle(state.jsonlHandle, state.jsonlLines.join("\n") + (state.jsonlLines.length ? "\n" : ""));
  await writeHandle(state.metadataHandle, state.metadataLines.join("\n") + "\n");
}

function rebuildManifestLines() {
  const sessionJsonlLines = state.savedRecords.map((record) =>
    JSON.stringify({ audio: record.audioPath, text: record.text, duration: record.duration }),
  );
  const sessionMetadataRows = state.savedRecords.map((record) =>
    [record.audioPath, record.text, record.duration.toFixed(2), record.taskIndex + 1, record.createdAt]
      .map(csvEscape)
      .join(","),
  );
  state.jsonlLines = [...state.baseJsonlLines, ...sessionJsonlLines];
  state.metadataLines = [
    "file,text,duration,index,created_at",
    ...state.baseMetadataRows,
    ...sessionMetadataRows,
  ];
}

async function readExistingLines(fileHandle) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readExistingMetadataRows(fileHandle) {
  const lines = await readExistingLines(fileHandle);
  if (lines[0]?.toLowerCase() === "file,text,duration,index,created_at") {
    return lines.slice(1);
  }
  return lines;
}

async function nextSequenceFromDirectory(audioDir, jsonlLines) {
  const candidates = jsonlLines
    .map((line) => {
      try {
        return JSON.parse(line).audio;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  if (audioDir?.values) {
    for await (const handle of audioDir.values()) {
      if (handle.kind === "file") candidates.push(handle.name);
    }
  }

  return nextSequenceFromNames(candidates);
}

function nextSequenceFromRecords() {
  const names = [
    ...state.baseJsonlLines.map((line) => {
      try {
        return JSON.parse(line).audio;
      } catch {
        return "";
      }
    }),
    ...state.savedRecords.map((record) => record.fileName),
  ];
  return nextSequenceFromNames(names);
}

function nextSequenceFromNames(names) {
  const maxSequence = names.reduce((max, name) => {
    const match = String(name).match(/sample_(\d+)\.wav$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return maxSequence + 1;
}

function reassignSessionFiles(startSequence) {
  let sequence = startSequence;
  for (const record of state.savedRecords) {
    const fileName = `sample_${String(sequence).padStart(3, "0")}.wav`;
    record.sequence = sequence;
    record.fileName = fileName;
    record.audioPath = `audio/${fileName}`;
    const task = state.tasks[record.taskIndex];
    if (task) task.fileName = fileName;
    sequence += 1;
  }
  state.sequence = sequence;
}

async function writeSessionAudioFiles() {
  if (!state.audioDirHandle) return;
  for (const record of state.savedRecords) {
    await writeFile(state.audioDirHandle, record.fileName, record.blob);
  }
}

async function deleteSessionAudio(fileName) {
  if (!state.audioDirHandle || !fileName) return;
  try {
    await state.audioDirHandle.removeEntry(fileName);
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
}

async function exportZip() {
  if (state.savedRecords.length === 0) {
    showToast("请至少保存一条录音后再导出");
    return;
  }

  try {
    const sessionJsonl = state.savedRecords
      .map((record) =>
        JSON.stringify({ audio: record.audioPath, text: record.text, duration: record.duration }),
      )
      .join("\n");
    const sessionMetadata = [
      "file,text,duration,index,created_at",
      ...state.savedRecords.map((record) =>
        [record.audioPath, record.text, record.duration.toFixed(2), record.taskIndex + 1, record.createdAt]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n");
    const zipBlob = await createZipBlob({
      "train.jsonl": stringToUint8(sessionJsonl + "\n"),
      "metadata.csv": stringToUint8(sessionMetadata + "\n"),
      ...Object.fromEntries(
        state.savedRecords.map((record) => [`audio/${record.fileName}`, record.blob]),
      ),
    });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `voxcpm2_dataset_${timestampName()}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
    showToast("ZIP 导出失败，请稍后再试");
  }
}

function renderAll() {
  const poolSize = getActivePool().length;
  els.poolSummary.textContent = `内置 ${state.builtinTexts.length} 条，自定义 ${state.customTexts.length} 条，当前池 ${poolSize} 条`;
  els.customSummary.textContent = state.customTexts.length
    ? `已载入 ${state.customTexts.length} 条自定义文案`
    : "尚未上传自定义文案";
  els.durationText.textContent = `本次已保存 ${state.totalSavedDuration.toFixed(2)} 秒`;
  els.promptText.textContent = getCurrentTask()?.text ?? "全部完成";
  els.listSummary.textContent = `随机抽取 ${state.tasks.length} 条`;
  els.completionBadge.textContent = `${state.savedRecords.length}/${state.tasks.length}`;
  const progress = state.tasks.length
    ? Math.round((state.savedRecords.length / state.tasks.length) * 100)
    : 0;
  if (els.progressFill) els.progressFill.style.width = `${progress}%`;
  renderPromptMeta();
  updateActionButtons();
  renderTaskList();
}

function renderPromptMeta() {
  const total = state.tasks.length;
  const currentNumber = total ? Math.min(state.currentIndex + 1, total) : 0;
  const progress = total ? Math.round((state.savedRecords.length / total) * 100) : 0;
  const nextTask = state.tasks[state.currentIndex + 1];
  const nextText = nextTask?.text ?? (isTaskComplete() ? "全部录制完成" : "已经是最后一条");

  els.progressText.textContent = total ? `第 ${currentNumber}/${total} 条` : "第 0/0 条";
  if (els.promptMeta) {
    els.promptMeta.classList.toggle("is-compact", !state.isTaskPanelCollapsed);
  }
  if (els.promptProgressFill) {
    els.promptProgressFill.style.width = `${progress}%`;
  }
  if (els.nextPromptText) {
    els.nextPromptText.textContent = `下一条：${nextText}`;
  }
}

function renderTaskList() {
  els.taskList.replaceChildren(
    ...state.tasks.map((task, index) => {
      const li = document.createElement("li");
      li.textContent = task.text;
      if (index === state.currentIndex && !isTaskComplete()) li.classList.add("is-current");
      if (task.saved) li.classList.add("is-done");
      return li;
    }),
  );
  els.taskList.querySelector(".is-current")?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
}

function setStatus(status, message) {
  state.status = status;
  els.statusText.textContent = message;
  els.statusDot.className = "status-dot";
  if (status === "recording") els.statusDot.classList.add("status-dot--recording");
  else if (status === "pending") els.statusDot.classList.add("status-dot--pending");
  else if (status === "done") els.statusDot.classList.add("status-dot--done");
  else els.statusDot.classList.add("status-dot--ready");
  els.statusStrip.classList.toggle("is-recording", status === "recording");
  updateActionButtons();
}

function updateActionButtons() {
  let label = "开始录制";
  if (state.status === "recording") {
    label = "停止录制";
  } else if (state.status === "pending") {
    label = "重新录制";
  } else {
    label = isTaskComplete() ? "任务完成" : "开始录制";
  }

  els.recordButton.setAttribute("aria-label", label);
  els.recordButton.title = label;
  els.recordButton.classList.toggle("is-recording", state.status === "recording");
  els.vocalAura?.classList.toggle("is-recording", state.status === "recording");
  els.recordButton.disabled = isTaskComplete() && state.status !== "pending";
  els.saveButton.disabled = !state.tempRecording || state.status === "recording";
  els.undoButton.disabled = state.sessionStack.length === 0 || state.status === "recording";
  els.sampleRateOptions.querySelectorAll("[data-sample-rate]").forEach((button) => {
    button.disabled = state.status === "recording";
  });
  if (state.status === "recording") closeAudioDeviceMenu();
  if (els.audioInputButton) els.audioInputButton.disabled = state.status === "recording";
  if (els.refreshDevicesButton) els.refreshDevicesButton.disabled = state.status === "recording";
}

function setActiveButton(root, selector, value, key) {
  root.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("is-active", button.dataset[key] === value);
  });
}

function getCurrentTask() {
  return state.tasks[state.currentIndex] ?? null;
}

function isTaskComplete() {
  return state.currentIndex >= state.tasks.length;
}

function clearPlayback() {
  if (els.playback.src) {
    URL.revokeObjectURL(els.playback.src);
  }
  els.playback.removeAttribute("src");
  els.playback.load();
  els.saveButton.disabled = true;
}

function updateLevel() {}

function tickTimer() {
  if (state.status !== "recording" || !state.recorder?.startedAt) return;
  const seconds = (performance.now() - state.recorder.startedAt) / 1000;
  updateTimer(seconds);
  requestAnimationFrame(tickTimer);
}

function updateTimer(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  els.timer.textContent = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function prepareCanvas() {
  resizeCanvas();
  window.addEventListener("resize", () => {
    resizeCanvas();
    drawWaveform(state.tempRecording?.samples ?? new Float32Array(2048));
  });
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = els.waveform.getBoundingClientRect();
  els.waveform.width = Math.max(300, Math.floor(rect.width * ratio));
  els.waveform.height = Math.max(72, Math.floor(rect.height * ratio));
  canvasContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawWaveform(samples) {
  const width = els.waveform.clientWidth;
  const height = els.waveform.clientHeight;
  canvasContext.clearRect(0, 0, width, height);

  const barWidth = 8;
  const gap = 6;
  const bars = Math.max(18, Math.floor(width / (barWidth + gap)));
  const step = Math.max(1, Math.floor(samples.length / bars));
  const mid = height / 2;

  canvasContext.fillStyle = "#050506";
  for (let i = 0; i < bars; i += 1) {
    let peak = 0;
    const start = i * step;
    const end = Math.min(samples.length, start + step);
    for (let j = start; j < end; j += 1) {
      peak = Math.max(peak, Math.abs(samples[j] || 0));
    }
    const idle = state.status === "recording"
      ? 0.28 + Math.abs(Math.sin(performance.now() * 0.006 + i * 0.62)) * 0.38
      : 0.18 + Math.abs(Math.sin(i * 0.85)) * 0.2;
    const normalized = Math.max(idle, Math.min(1, peak * (state.status === "recording" ? 9 : 5)));
    const barHeight = Math.max(14, normalized * height * 0.86);
    const x = i * (barWidth + gap) + 2;
    const y = mid - barHeight / 2;
    fillRoundedRect(canvasContext, x, y, barWidth, barHeight, 4);
  }
}

function fillRoundedRect(context, x, y, width, height, radius) {
  if (typeof context.roundRect === "function") {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fill();
    return;
  }

  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.fill();
}

function initShaderBackground() {
  const canvas = els.shaderCanvas;
  if (!canvas) return;

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: "high-performance",
  });
  if (!gl) return;

  const REST_SPACING_PX = 25;
  const BASE_POINT_SIZE = 1.15;
  const LIFT_POINT_SIZE = 4.6;
  const MOUSE_FOLLOW_SECONDS = 0.5;

  const vertexShaderSource = `#version 300 es
precision highp float;

uniform int uColumns;
uniform int uRows;
uniform float uTime;
uniform float uAspect;
uniform float uPixelRatio;
uniform vec2 uCssViewport;
uniform vec4 uMouse;

out float vLift;
out float vCompression;
out float vDotScale;
out vec3 vColor;

const float CSS_PIXELS_PER_CM = 37.7952755906;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float perlin(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
  float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 rot = mat2(0.78, -0.63, 0.63, 0.78);

  for (int i = 0; i < 4; i++) {
    value += amplitude * perlin(p);
    p = rot * p * 2.03 + vec2(10.7, -3.9);
    amplitude *= 0.5;
  }

  return value;
}

vec2 curlNoise(vec2 p) {
  float e = 0.075;
  float n1 = fbm(p + vec2(0.0, e));
  float n2 = fbm(p - vec2(0.0, e));
  float n3 = fbm(p + vec2(e, 0.0));
  float n4 = fbm(p - vec2(e, 0.0));
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

vec2 metricFromClip(vec2 clipPosition) {
  return vec2(clipPosition.x * uAspect, clipPosition.y);
}

vec2 clipFromMetric(vec2 metricPosition) {
  return vec2(metricPosition.x / max(uAspect, 0.0001), metricPosition.y);
}

float cssDistanceFromMetric(float metricDistance) {
  return metricDistance * uCssViewport.y * 0.5;
}

vec2 latticeCoordinate() {
  int x = gl_VertexID % uColumns;
  int y = gl_VertexID / uColumns;
  vec2 uv = vec2(float(x), float(y)) / vec2(float(uColumns - 1), float(uRows - 1));
  vec2 jitter = hash2(vec2(float(x), float(y))) * 0.20 / vec2(float(uColumns - 1), float(uRows - 1));
  uv = clamp(uv + jitter, vec2(0.0), vec2(1.0));

  return uv * 2.0 - 1.0;
}

void main() {
  vec2 baseClip = latticeCoordinate();
  vec2 baseMetric = metricFromClip(baseClip);
  vec2 mouseMetric = metricFromClip(uMouse.xy);
  vec2 delta = baseMetric - mouseMetric;
  float distanceToMouse = length(delta);
  vec2 sourceDirection = distanceToMouse > 0.0001 ? delta / distanceToMouse : vec2(0.0, 1.0);
  vec2 swirlDirection = vec2(-sourceDirection.y, sourceDirection.x);

  float cssDistance = cssDistanceFromMetric(distanceToMouse);
  vec2 world = vec2(baseMetric.x * 1.18 + baseMetric.y * 0.24, baseMetric.y * 0.92 - baseMetric.x * 0.31);
  vec2 stableField = world;
  float largeEddy = fbm(stableField * 1.28 + vec2(uTime * 0.036, -uTime * 0.026));
  float detailEddy = fbm(stableField * 2.35 + vec2(-uTime * 0.060, uTime * 0.045));
  float asymmetry = fbm(vec2(stableField.x * 1.10 - stableField.y * 0.38, stableField.y * 0.78 + stableField.x * 0.24) * 1.72 + vec2(uTime * 0.032, uTime * 0.041));
  float angle = atan(delta.y, delta.x);
  float angularBreakup = fbm(vec2(angle * 0.92 + distanceToMouse * 0.22, distanceToMouse * 0.82) + stableField * 0.32 + vec2(uTime * 0.022, -uTime * 0.018));
  float slowBreath = 0.5 + 0.5 * sin(uTime * 0.34 + largeEddy * 1.8 + asymmetry * 1.35);
  float secondaryBreath = 0.5 + 0.5 * sin(uTime * 0.22 - detailEddy * 1.35 + angularBreakup * 1.8);
  float unevenBreath = (slowBreath - 0.5) * (0.10 + abs(asymmetry) * 0.05) + (secondaryBreath - 0.5) * largeEddy * 0.045;
  float distanceWarp = clamp(1.0 + largeEddy * 0.18 + detailEddy * 0.055 + asymmetry * 0.13 + angularBreakup * 0.14 - unevenBreath * 0.42, 0.66, 1.36);
  float distortedDistance = cssDistance * distanceWarp;
  float baseReach = clamp(uCssViewport.x * 0.23, 350.0, 510.0);
  float waveReach = baseReach * clamp(1.0 + largeEddy * 0.12 + asymmetry * 0.08 + angularBreakup * 0.09 + unevenBreath, 0.80, 1.22);
  waveReach += detailEddy * 12.0;
  float waveMask = 1.0 - smoothstep(waveReach * 0.52, waveReach, distortedDistance);
  float normalizedDistance = clamp(distortedDistance / max(waveReach, 1.0), 0.0, 1.45);
  float centerField = (1.0 - smoothstep(0.00, 0.24, normalizedDistance)) * waveMask;
  float bandCenter = clamp(0.36 + slowBreath * 0.18 + asymmetry * 0.045 + angularBreakup * 0.055, 0.30, 0.68);
  float bandWidth = clamp(0.23 + secondaryBreath * 0.055 + abs(detailEddy) * 0.030, 0.21, 0.34);
  float activeBand = exp(-pow((normalizedDistance - bandCenter) / bandWidth, 2.0)) * waveMask;
  activeBand *= smoothstep(0.06, 0.18, normalizedDistance);
  float outerBandCenter = clamp(0.74 + angularBreakup * 0.045 - asymmetry * 0.025, 0.60, 0.90);
  float outerPinch = exp(-pow((normalizedDistance - outerBandCenter) / 0.18, 2.0)) * waveMask;
  float outerRelax = smoothstep(0.82, 1.08, normalizedDistance);
  float edgeField = outerPinch * (0.70 + secondaryBreath * 0.30);
  float densityScale = 1.0;
  float centerCushion = centerField * (0.18 + slowBreath * 0.16) * (0.90 + largeEddy * 0.12);
  densityScale += centerCushion * 0.45;
  densityScale += activeBand * (1.42 + slowBreath * 0.44 + largeEddy * 0.14);
  densityScale -= outerPinch * (0.34 + abs(detailEddy) * 0.12);
  densityScale = mix(densityScale, 1.0, outerRelax);
  densityScale = clamp(densityScale, 0.56, 2.36);
  float shearMagnitude = (activeBand * (0.88 + slowBreath * 0.24) + centerCushion * 0.28 + outerPinch * 0.34) * waveMask;
  float mound = centerCushion * 0.28;
  float compressionBand = edgeField * uMouse.w;
  float surfaceRipple = sin(cssDistance * 0.030 - uTime * 0.24 + largeEddy * 3.0 + angularBreakup * 1.35) * waveMask;
  float radialPressure = mound * uMouse.w * 0.38;
  float mediumPressure = (activeBand * 0.76 + outerPinch * 0.24 + centerCushion * 0.18) * uMouse.w;

  float centimeterMetric = (2.0 * CSS_PIXELS_PER_CM) / max(uCssViewport.y, 1.0);
  float amplitude = centimeterMetric * mix(0.72, 1.02, uMouse.z);
  vec2 localCurl = curlNoise(stableField * 1.80 + vec2(uTime * 0.032, -uTime * 0.026));
  vec2 perturbation = swirlDirection * (0.070 + detailEddy * 0.014 - asymmetry * 0.012);
  perturbation += localCurl * 0.024;
  perturbation += vec2(asymmetry, largeEddy - detailEddy) * 0.010;

  vec2 shearDirection = normalize(swirlDirection * (0.94 + asymmetry * 0.06) + localCurl * 0.08 + perturbation * 0.07 + vec2(0.0001, -0.0001));
  vec2 densityShear = shearDirection * amplitude * shearMagnitude * uMouse.w * 0.58;
  vec2 moundShear = shearDirection * amplitude * radialPressure * 0.10;
  vec2 compressionShear = shearDirection * amplitude * compressionBand * 0.18;
  vec2 rippleShear = (perturbation * 0.70 + localCurl * 0.30) * amplitude * mediumPressure * 0.035;
  vec2 radialResidual = sourceDirection * surfaceRipple * amplitude * mediumPressure * 0.004;
  vec2 deformation = densityShear + moundShear + compressionShear + rippleShear + radialResidual;

  vec2 flowSample = baseMetric * 0.82 + vec2(uTime * 0.038, -uTime * 0.027);
  vec2 globalCurl = curlNoise(flowSample) * 0.012;
  vec2 mouseCurl = localCurl * mediumPressure * centimeterMetric * 0.006;
  float mouseEnergy = clamp(activeBand * 1.12 + centerCushion * 0.24 + outerPinch * 0.44 + mediumPressure * 0.45 + abs(densityScale - 1.0) * 0.18, 0.0, 1.0);
  float turbulence = clamp(mouseEnergy * (0.82 + abs(detailEddy) * 0.16), 0.0, 1.0);

  vec2 deformedMetric = baseMetric + globalCurl + deformation + mouseCurl;
  vec2 deformedClip = clipFromMetric(deformedMetric);

  vLift = turbulence;
  vCompression = clamp((abs(asymmetry) * 0.48 + abs(detailEddy) * 0.24) * mouseEnergy, 0.0, 1.0);
  vDotScale = smoothstep(0.08, 0.86, turbulence);
  vec3 restColor = vec3(0.050, 0.058, 0.055);
  vec3 liftColor = mix(vec3(0.08, 0.42, 0.90), vec3(0.96, 0.30, 0.20), smoothstep(0.32, 0.92, turbulence + asymmetry * 0.12));
  vColor = mix(restColor, liftColor, vDotScale);

  gl_Position = vec4(deformedClip, 0.0, 1.0);
  gl_PointSize = uPixelRatio * mix(${BASE_POINT_SIZE.toFixed(2)}, ${LIFT_POINT_SIZE.toFixed(2)}, vDotScale);
}`;

  const fragmentShaderSource = `#version 300 es
precision highp float;

in float vLift;
in float vCompression;
in float vDotScale;
in vec3 vColor;

out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radiusSquared = dot(point, point);
  float mask = smoothstep(1.0, 0.20, radiusSquared);

  if (mask < 0.01) {
    discard;
  }

  float opacity = mix(0.54, 0.96, vDotScale) * mask;
  vec3 color = mix(vColor, vec3(0.035, 0.042, 0.040), vCompression * 0.16);
  outColor = vec4(color, opacity);
}`;

  const program = createWebglProgram(gl, vertexShaderSource, fragmentShaderSource);
  if (!program) return;

  const uniforms = getUniforms(gl, program, [
    "uColumns",
    "uRows",
    "uTime",
    "uAspect",
    "uPixelRatio",
    "uCssViewport",
    "uMouse",
  ]);
  const vao = gl.createVertexArray();

  let pixelRatio = 1;
  let aspect = 1;
  let cssWidth = 1;
  let cssHeight = 1;
  let latticeColumns = 1;
  let latticeRows = 1;
  let latticePointCount = 1;
  let lastFrameTime = performance.now();
  const pointer = { x: 0, y: 0, down: 0, active: 0.78 };
  const smoothedMouse = { x: 0, y: 0, down: 0, active: 0.78 };

  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = Math.max(1, window.innerWidth);
    cssHeight = Math.max(1, window.innerHeight);
    const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
    const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
    const columns = Math.max(12, Math.round(cssWidth / REST_SPACING_PX) + 1);
    const rows = Math.max(12, Math.round(cssHeight / REST_SPACING_PX) + 1);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    latticeColumns = columns;
    latticeRows = rows;
    latticePointCount = latticeColumns * latticeRows;
    aspect = width / height;
  }

  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
    pointer.x = x * 2 - 1;
    pointer.y = 1 - y * 2;
    pointer.active = 1;
  }

  function updateSmoothedMouse(delta) {
    const damping = 1 - Math.exp(-delta / MOUSE_FOLLOW_SECONDS);
    smoothedMouse.x += (pointer.x - smoothedMouse.x) * damping;
    smoothedMouse.y += (pointer.y - smoothedMouse.y) * damping;
    smoothedMouse.down += (pointer.down - smoothedMouse.down) * damping;
    smoothedMouse.active += (pointer.active - smoothedMouse.active) * damping;
  }

  function render(now) {
    const time = now / 1000;
    const delta = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    updateSmoothedMouse(delta);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.969, 0.961, 0.929, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.uniform1i(uniforms.uColumns, latticeColumns);
    gl.uniform1i(uniforms.uRows, latticeRows);
    gl.uniform1f(uniforms.uTime, time);
    gl.uniform1f(uniforms.uAspect, aspect);
    gl.uniform1f(uniforms.uPixelRatio, pixelRatio);
    gl.uniform2f(uniforms.uCssViewport, cssWidth, cssHeight);
    gl.uniform4f(uniforms.uMouse, smoothedMouse.x, smoothedMouse.y, smoothedMouse.down, smoothedMouse.active);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, latticePointCount);
    gl.disable(gl.BLEND);
    requestAnimationFrame(render);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", updatePointer, { passive: true });
  window.addEventListener("pointerdown", (event) => {
    pointer.down = 1;
    updatePointer(event);
  }, { passive: true });
  window.addEventListener("pointerup", (event) => {
    pointer.down = 0;
    updatePointer(event);
  }, { passive: true });
  window.addEventListener("pointercancel", () => {
    pointer.down = 0;
  }, { passive: true });
  window.addEventListener("pointerleave", () => {
    pointer.down = 0;
    pointer.active = 0.68;
  }, { passive: true });
  window.addEventListener("pointerenter", (event) => {
    pointer.active = 1;
    updatePointer(event);
  }, { passive: true });

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(vao);
  resize();
  requestAnimationFrame(render);
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebglProgram(gl, vertexShaderSource, fragmentShaderSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function getUniforms(gl, program, names) {
  return names.reduce((uniforms, name) => {
    uniforms[name] = gl.getUniformLocation(program, name);
    return uniforms;
  }, {});
}

function updateDirectorySupport() {
  const supportsDirectory = "showDirectoryPicker" in window;
  els.directoryButton.disabled = !supportsDirectory;
  if (state.outputHandle) {
    els.storageMode.textContent = "目录直写";
    els.outputSummary.textContent = "已选择 output 目录：audio、train.jsonl、metadata.csv 会自动同步。";
  } else if (supportsDirectory) {
    els.storageMode.textContent = "选择 output";
    els.outputSummary.textContent = "可选择 output 目录直接写入，也可随时导出 ZIP。";
  } else {
    els.storageMode.textContent = "ZIP 导出";
    els.outputSummary.textContent = "当前浏览器不支持目录直写，请使用 ZIP 导出。";
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  els.toastRegion.append(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 3200);
}

function normalizeTexts(values) {
  return dedupeTexts(
    values
      .map((value) => String(value).trim())
      .map((value) => value.replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  );
}

function dedupeTexts(values) {
  return [...new Set(values)];
}

function parseCsvSingleColumn(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith('"') && line.endsWith('"')) {
        return line.slice(1, -1).replace(/""/g, '"');
      }
      return line.split(",")[0];
    });
}

function sample(values, count) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function calculateRms(samples) {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function mergeAudioChunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i += 1) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function roundDuration(duration) {
  return Math.round(duration * 100) / 100;
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function writeFile(directoryHandle, fileName, blob) {
  const handle = await directoryHandle.getFileHandle(fileName, { create: true });
  await writeHandle(handle, blob);
}

async function writeHandle(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

function stringToUint8(value) {
  return new TextEncoder().encode(value);
}

async function createZipBlob(entries) {
  const files = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = content instanceof Blob
      ? new Uint8Array(await content.arrayBuffer())
      : content;
    const nameBytes = stringToUint8(name);
    const crc = crc32(data);
    const mod = dosDateTime(new Date());
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, mod.time, true);
    localView.setUint16(12, mod.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    files.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, mod.time, true);
    centralView.setUint16(14, mod.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    central.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralSize = central.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...files, ...central, end], { type: "application/zip" });
}

function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function timestampName() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("");
}

const CRC_TABLE = createCrcTable();

init();
