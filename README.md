# VoiceForge

VoxCPM2 交互式录音训练数据生成器。  
一个零构建、零后端依赖的本地 Web 工具，用于录制 VoxCPM2 LoRA 训练数据，并生成可直接使用的 `audio/`、`train.jsonl` 和 `metadata.csv`。

GitHub: https://github.com/cuser-it/VoiceForge

## 启动

```bash
python3 -m http.server 4173
```

打开：

```text
http://127.0.0.1:4173/
```

不要直接用 `file://` 打开页面；浏览器会拦截本地 JSON 文案库加载。

## 当前功能

- 内置 300 条普通话文案，位于 `data/text_pool.json`。
- 当前内置文案为单段自然句，去掉标点后约 18 到 25 个汉字。
- 支持 TXT/CSV 自定义文案追加到内置池。
- 支持选择录制条数：20、30、50。
- 支持随机抽取、任务列表预览、重新洗牌。
- 支持麦克风设备识别与切换。
- 支持输出采样率选择：16kHz、24kHz、48kHz。
- 支持实时波形、VAD 静音停止、自动回放。
- 当前 VAD 静音停止等待约 3.2 秒，避免中途换气被过早截断。
- 支持本次会话撤销，不触碰历史录音文件。
- 支持选择目录直写，也支持导出 ZIP。
- 使用 Simulation 项目的 WebGL2 deformable lattice 背景。
- 顶部提供 GitHub 仓库入口。

## 使用流程

1. 选择录制条数：20、30 或 50。
2. 可选上传 `.txt` 或单列 `.csv` 自定义文案。
3. 预览右侧任务列表，不满意可重新洗牌。
4. 选择麦克风设备和输出采样率。
5. 按空格开始录音，朗读当前文案。
6. 朗读结束后自然停顿约 3 秒，系统会自动停止录音。
7. 自动回放后，按回车保存并进入下一条。
8. 不满意时按空格重录。
9. 按 `Ctrl+Z` 撤销本次会话上一条保存记录。
10. 完成后选择目录直写，或点击“导出 ZIP”下载完整数据集。

## 快捷键

```text
Space   开始录音 / 停止录音 / 重录
Enter   保存当前录音并进入下一条
Ctrl+Z  撤销本次会话上一条保存记录
```

## 输出结构

```text
output/
├── audio/
│   ├── sample_001.wav
│   └── ...
├── train.jsonl
└── metadata.csv
```

`train.jsonl` 示例：

```json
{"audio":"audio/sample_001.wav","text":"清晨的阳光照进房间，桌上的水杯映出一圈浅浅的光。","duration":3.52}
```

音频输出为单声道 WAV，并按页面选择的采样率导出。

## 数据保存说明

这个项目没有后端服务，录音不会上传服务器。

- 未选择 output 目录时：录音只暂存在当前浏览器页面内存中。
- 刷新页面后：未导出的临时录音会丢失。
- 选择 output 目录后：保存时会写入本地目录。
- 点击导出 ZIP：会下载包含 `audio/`、`train.jsonl`、`metadata.csv` 的数据集压缩包。

## 浏览器要求

- 推荐 Chrome 或 Edge。
- 麦克风名称需要浏览器授权后才能显示。
- 目录直写依赖 File System Access API，不支持时请使用 ZIP 导出。
- 背景使用 WebGL2；不支持 WebGL2 的环境会退化为普通背景。

## 项目结构

```text
.
├── index.html
├── src/
│   ├── app.js
│   └── styles.css
├── data/
│   └── text_pool.json
├── assets/
│   └── stitch/
└── README.md
```
