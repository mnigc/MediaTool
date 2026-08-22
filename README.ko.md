[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md) | [🇷🇺 Русский](README.ru.md)

---

# MediPress

로컬 미디어 압축 및 변환 도구로, 비디오, 이미지, 오디오 파일을 일괄 처리할 수 있습니다. **Tauri 2 + React + TypeScript** 기반 데스크톱 애플리케이션으로, **FFmpeg**를 처리 엔진으로 사용합니다.

> 법적 준수: 기본적으로 특허 위험이 없는 코덱만 활성화됩니다(H.264/AAC 특허 만료, VP9/Opus/WebP/AVIF는 로열티 프리). **HEVC/H.265** 등 특허 위험이 있는 코덱은 **제공되지 않습니다**.

## 기능

- **비디오 압축 및 변환** — H.264, VP9 인코딩, CRF/목표 크기/고정 비트레이트 품질 모드, 사용자 정의 해상도(480p ~ 2160p), 인코딩 속도, 트림 제어
- **이미지 압축 및 변환** — JPEG, PNG, WebP 형식 변환, 품질 조정 및 최대 크기 제한
- **오디오 변환** — MP3, AAC, M4A, Opus, FLAC 형식 변환, 비트레이트 제어
- **오디오 추출** — 비디오에서 오디오 트랙 추출(MP3/AAC/Opus/FLAC)
- **GPU 가속** — NVIDIA NVENC, Intel QSV, Apple VideoToolbox, AMD AMF, VAAPI 자동 감지
- **일괄 처리** — 드래그 앤 드롭 또는 파일 선택기로 일괄 가져오기, 동시 처리 제어(1/2/4)
- **내장 프리셋** — YouTube, Bilibili, Douyin, Xiaohongshu, WeChat Channels에 최적화
- **사용자 정의 프리셋** — 자주 사용하는 매개변수를 프리셋으로 저장하여 빠르게 재사용
- **출력 크기 예측** — 매개변수 기반 이론적 추정 + 샘플 인코딩으로 정확한 예측
- **실시간 진행 상황** — 진행률 표시줄, 속도, ETA 예측
- **드래그 앤 드롭 정렬** — 작업 목록을 드래그하여 순서 변경
- **다국어** — 中文, English, 한국어, 日本語, Русский, Español
- **테마** — 라이트 / 다크 / 시스템 설정
- **출력 접미사** — 사용자 정의 출력 파일명 접미사로 원본 파일 덮어쓰기 방지

## 스크린샷

![MediPress 스크린샷](https://via.placeholder.com/800x500?text=MediPress+Screenshot)

## 요구 사항

- **Node.js** ≥ 18 (npm 포함)
- **Rust** 툴체인 ([rustup](https://rustup.rs/)으로 설치, `stable` 및 MSVC 대상 포함)
- **FFmpeg**: 실행 시 `ffmpeg` / `ffprobe` 필요. 다음 순서로 검색:
  1. 실행 파일과 같은 디렉토리(`ffmpeg.exe` / `ffprobe.exe`);
  2. Tauri 리소스 디렉토리(`resource_dir`);
  3. 시스템 `PATH`.
  - 찾을 수 없으면 "FFmpeg를 찾을 수 없음" 메시지 표시.
  - 권장: `pwsh scripts/fetch-ffmpeg.ps1` 실행하여 다운로드 후 `src-tauri/binaries/`에 배치.
  - 또는 시스템에 FFmpeg를 설치하고 `PATH`에 추가.

## 의존성 설치

```bash
npm install
```

## 개발 모드 시작

```bash
npm run tauri dev
```

Vite 프론트엔드(http://localhost:1420)를 시작한 후 Rust 백엔드 창을 컴파일 및 시작합니다. 프론트엔드 변경은 핫 리로드, Rust 변경은 재컴파일됩니다.

## 설치 프로그램 빌드

```bash
npm run tauri build
```

출력 위치: `src-tauri/target/release/bundle/` (Windows: `.msi` / `.exe`).

## 스크립트

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 프론트엔드만 (Vite, Tauri 창 없음) |
| `npm run build` | 프론트엔드 정적 자산만 빌드 |
| `npm run tauri dev` | 전체 데스크톱 앱 (개발) |
| `npm run tauri build` | 데스크톱 앱 패키징 (릴리스) |

## 디렉토리 구조

```
MediPress/
├── src/                    # React 프론트엔드
│   ├── components/         # UI 컴포넌트 (JobCard, OptionsPanel, Sidebar 등)
│   ├── hooks/              # 사용자 정의 Hooks (useJobs, useTheme, useToasts)
│   ├── i18n/               # 국제화 (6개 언어)
│   ├── lib/                # 유틸리티 (프리셋 관리, 출력 추정, Tauri 호출)
│   ├── App.tsx             # 메인 앱 컴포넌트
│   ├── main.tsx            # 진입점
│   ├── types.ts            # TypeScript 타입 정의
│   └── index.css           # 스타일 (Tailwind CSS 4)
├── src-tauri/              # Rust 백엔드
│   ├── src/                # Rust 소스
│   │   ├── commands.rs     # Tauri 명령 등록
│   │   ├── jobs.rs         # 작업 큐, FFmpeg 인수, 진행/이벤트
│   │   ├── ffmpeg.rs       # FFmpeg 프로세스 검색 및 실행
│   │   ├── media.rs        # ffprobe 미디어 감지
│   │   ├── gpu.rs          # GPU 가속 감지
│   │   ├── thumbnail.rs    # 비디오/이미지 썸네일 생성
│   │   ├── models.rs       # 데이터 모델
│   │   ├── state.rs        # 작업 관리자 (자식 프로세스 생명주기)
│   │   └── error.rs        # 오류 유형
│   ├── binaries/           # FFmpeg sidecar 바이너리 (gitignored)
│   ├── icons/              # 앱 아이콘
│   └── tauri.conf.json     # Tauri 설정
├── scripts/                # 도우미 스크립트
│   ├── fetch-ffmpeg.ps1    # FFmpeg 바이너리 다운로드
│   └── await-ffmpeg.ps1    # FFmpeg 준비 대기
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Tailwind CSS 4
- **데스크톱 프레임워크**: Tauri 2
- **백엔드**: Rust (Tauri 명령)
- **처리 엔진**: FFmpeg (sidecar 프로세스)
- **빌드 도구**: Vite 7

## 참고

- FFmpeg 바이너리는 큽니다. `scripts/fetch-ffmpeg.ps1`은 GitHub에서 GPL 빌드(x264 / VP9 / AV1 / MP3 / Opus 인코더 포함)를 다운로드합니다. 다운로드가 느린 경우 인내심을 갖고 기다리거나 수동으로 FFmpeg를 `PATH`에 설치하세요.
- 개발 시 `ffmpeg.exe` / `ffprobe.exe`를 `src-tauri/binaries/`(또는 앱과 같은 디렉토리 / `PATH`)에 배치하세요.
- 프론트엔드는 Tailwind CSS 4를 사용합니다(`@tailwindcss/vite` 플러그인). PostCSS 설정 파일이 필요하지 않습니다.