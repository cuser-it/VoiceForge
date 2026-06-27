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

  const gl = canvas.getContext("webgl");
  if (!gl) return;

  let mouseX = 0;
  let mouseY = 0;
  let scrollY = 0;

  function syncSize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  window.addEventListener("resize", syncSize);
  window.addEventListener("mousemove", (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
  });
  window.addEventListener("scroll", () => {
    scrollY = window.scrollY;
  });
  syncSize();

  const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform float u_time;
    uniform vec2 u_resolution;
    uniform vec2 u_mouse;
    uniform float u_scroll;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 res = u_resolution.xy;
      vec2 p = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
      vec2 mouse = (u_mouse - 0.5 * res) / min(res.x, res.y);
      mouse.y *= -1.0;

      vec3 color = vec3(1.0);
      float gridSize = 0.078;
      vec2 gridPos = fract(p / gridSize + u_scroll * 0.001) - 0.5;
      float wave = sin(p.x * 2.0 + p.y * 2.0 + u_time + u_scroll * 0.01) * 0.18;
      float dotDist = length(gridPos + wave);
      float dots = smoothstep(0.038, 0.018, dotDist);
      color = mix(color, vec3(0.94), dots * 0.34);

      vec3 c1 = vec3(0.204, 0.420, 0.945);
      vec3 c2 = vec3(0.984, 0.737, 0.016);
      vec3 c3 = vec3(1.0, 0.275, 0.255);
      vec3 c4 = vec3(1.0, 0.584, 0.0);

      for(float i = 0.0; i < 40.0; i++) {
        float h = hash(vec2(i, 13.0));
        float h2 = hash(vec2(i, 42.0));
        float angle = h * 6.283 + u_time * 0.1 * (h - 0.5);
        float distBase = fract(h * 15.0 + u_time * 0.02) * 0.82;
        vec2 particlePos = vec2(cos(angle), sin(angle)) * distBase;
        particlePos.y -= u_scroll * 0.0005 * (h + 0.5);

        float dToMouse = length(particlePos - mouse);
        float force = smoothstep(0.4, 0.0, dToMouse);
        particlePos += normalize(particlePos - mouse) * force * 0.05;

        float d = length(p - particlePos);
        float size = (0.003 + 0.005 * h2) * (1.0 + force * 2.0);
        vec3 pColor = c1;
        if(h > 0.25) pColor = c2;
        if(h > 0.5) pColor = c3;
        if(h > 0.75) pColor = c4;

        float bloom = smoothstep(size * 4.0, size, d);
        color = mix(color, pColor, bloom * 0.5);
        color = mix(color, pColor, smoothstep(size, size * 0.2, d) * 0.72);
      }

      float grain = hash(v_uv + u_time * 0.01) * 0.018;
      color -= grain;
      float vignette = 1.0 - length(v_uv - 0.5) * 0.16;
      color *= vignette;
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(program, "u_time");
  const uRes = gl.getUniformLocation(program, "u_resolution");
  const uMouse = gl.getUniformLocation(program, "u_mouse");
  const uScroll = gl.getUniformLocation(program, "u_scroll");

  function render(time) {
    const ratio = window.devicePixelRatio || 1;
    gl.uniform1f(uTime, time * 0.001);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uMouse, mouseX * ratio, (window.innerHeight - mouseY) * ratio);
    gl.uniform1f(uScroll, scrollY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }

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
