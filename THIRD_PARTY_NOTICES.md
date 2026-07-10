# PodPlayer Third-Party Notices

PodPlayer source code is licensed under the MIT License in [`LICENSE`](./LICENSE).
That license does not replace the licenses of third-party runtimes, binaries, or
models distributed with or downloaded by PodPlayer. Each item below remains
subject to its own license.

## SenseVoiceSmall model

- Files: `model.int8.onnx`, `tokens.txt`
- Model package: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
- Original project/model: FunAudioLLM / SenseVoiceSmall, Alibaba Group
- Runtime conversion/package attribution: sherpa-onnx model package maintained by
  Fangjun Kuang and the next-gen Kaldi project
- Primary download source: `huggingface.co/csukuangfj/...`
- Network fallback: `hf-mirror.com/csukuangfj/...`
- Integrity root: pinned file sizes and SHA256 values in
  `src/electron/asrModelManager.js`; the mirror is not a trust root
- License: FunASR Model Open Source License Agreement 1.1
- Official license source:
  <https://github.com/modelscope/FunASR/blob/701cef42e91c02048d402b8bcda0d4d973edb270/MODEL_LICENSE>
- Included snapshot: `third_party/licenses/FunASR-MODEL-LICENSE-1.1.txt`

PodPlayer displays the model name and source in its deployment manifest. A
successful deployment writes the complete license snapshot and attribution into
the shared model directory.

## Silero VAD model

- File: `silero_vad.onnx`
- Project/author: Silero VAD, Silero Team
- Download source: official sherpa-onnx `asr-models` GitHub release
- Integrity root: pinned file size and SHA256 in
  `src/electron/asrModelManager.js`
- License: MIT License, Copyright (c) 2020-present Silero Team
- Official license source:
  <https://github.com/snakers4/silero-vad/blob/fba061dc5559f696e62171e9a0741782b0fdc23c/LICENSE>
- Included snapshot: `third_party/licenses/Silero-VAD-MIT.txt`

## sherpa-onnx runtime

- npm packages: `sherpa-onnx-node@1.13.3` and the matching native platform package
- Project/author: sherpa-onnx, the next-gen Kaldi team
- License: Apache License 2.0
- Official versioned source:
  <https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.3/LICENSE>
- Included snapshot: `third_party/licenses/sherpa-onnx-Apache-2.0.txt`

PodPlayer 0.5.0 packages and validates the ASR runtime on Windows x64. The app
does not claim that local ASR is verified on macOS or Linux in this release.

## FFmpeg

- npm package: `ffmpeg-static@5.3.0`
- Packaged Windows binary: FFmpeg 6.1.1 essentials build from gyan.dev
- License for the packaged binary: GNU General Public License version 3
- Corresponding FFmpeg source commit:
  <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93>
- Included license snapshot: `third_party/licenses/FFmpeg-GPL-3.0.txt`
- Build/source record: `third_party/licenses/FFmpeg-Windows-x64-SOURCE.txt`

The packaged `node_modules/ffmpeg-static` resource also contains the dependency's
original `ffmpeg.exe.LICENSE` and `ffmpeg.exe.README` files next to the binary.

## Other dependencies

Other application dependencies remain governed by the license metadata and
license files shipped with their respective packages. This notice focuses on the
native ASR and model artifacts added for PodPlayer 0.5.0.
