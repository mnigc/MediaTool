[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md)

---

# MediaTool

로컬 미디어 압축 및 변환 도구로, 비디오, 이미지, 오디오 파일을 일괄 처리할 수 있습니다. **Tauri 2 + React + TypeScript** 기반 데스크톱 애플리케이션으로, **FFmpeg**를 처리 엔진으로 사용합니다.

> 법적 준수: 기본적으로 특허 위험이 없는 코덱만 활성화됩니다(H.264/AAC 특허 만료, VP9/Opus/WebP/AVIF/AV1은 로열티 프리). **HEVC/H.265** 등 특허 위험이 있는 코덱은 **제공되지 않습니다**.

## 기능

- **도구 상자 레이아웃** — 좌측 카테고리 도구 트리(비디오/오디오/이미지/도구, 총 37개 도구) + 하단 통합 작업 독, 서로 다른 도구의 작업 동시 실행
- **비디오 압축** — H.264, VP9, AV1 (SVT-AV1) 인코딩, CRF/목표 크기/고정 비트레이트 품질 모드, 해상도(480p ~ 2160p), 프레임 레이트, 인코딩 속도
- **비디오 변환** — 컨테이너·코덱 자유 조합(MP4/WebM/MKV/MOV × H.264/VP9/AV1), 컨테이너 전환 시 기본 코덱 자동 매칭
- **비디오 트림** — 무손실 빠른 모드(스트림 복사, 키프레임 정렬) 또는 정밀 모드(재인코딩)
- **오디오 트랙 제거** — 스트림 복사로 무손실 제거, 순식간 완료
- **회전 및 뒤집기** — 90° 시계/반시계, 180° 회전 및 수평/수직 미러
- **GIF 변환** — 팔레트 알고리즘 기반 고품질 움짤 생성
- **스크린샷 내보내기** — 단일 프레임 또는 일정 간격 PNG/JPEG 내보내기
- **속도 변경** — 0.25x ~ 4x 비디오/오디오 속도 변경(체인 atempo), 음소거 선택 가능
- **워터마크** — 비디오에 이미지 워터마크 합성, 9분할 위치·크기·불투명도 조절
- **오디오 압축 / 변환** — 포맷 유지 비트레이트 축소 또는 MP3/AAC/M4A/Opus/FLAC 상호 변환
- **오디오 추출** — 비디오에서 오디오 트랙을 독립 파일로 추출
- **이미지 압축 / 변환** — 원본 포맷 유지 품질·크기 조절 또는 WebP/JPEG/PNG/AVIF 상호 변환
- **메타데이터 제거** — EXIF/GPS 등 개인 정보 삭제; A/V는 무손실 처리, 이미지는 고품질 재인코딩
- **미디어 정보** — ffprobe 기반 전체 포맷/스트림 정보 즉시 조회
- **GPU 가속** — NVIDIA NVENC, Intel QSV, Apple VideoToolbox, AMD AMF, VAAPI 자동 감지
- **이름 충돌 정책** — 출력 파일 이름이 중복될 때 자동 이름 변경, 건너뛰기 또는 덮어쓰기
- **내장 및 사용자 정의 프리셋** — 도구별로 격리된 프리셋 시스템
- **출력 크기 예측** — 매개변수 기반 이론적 추정 + 샘플 인코딩으로 정확한 예측
- **다국어** — 中文, English | **테마** — 라이트 / 다크 / 시스템 설정

## 스크린샷

![MediaTool 스크린샷](https://via.placeholder.com/800x500?text=MediaTool+Screenshot)

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
MediaTool/
├── src/                    # React 프론트엔드
│   ├── components/         # UI 컴포넌트 (JobCard, JobList, ToolNav, OptionsPanel 등)
│   ├── contexts/           # TaskCenter (통합 작업 대기열, 이벤트, 설정)
│   ├── tools/              # 도구 상자: 도구 레지스트리, 워크벤치, 파라미터 패널
│   ├── workflow/           # 다단계 워크플로 엔진과 타입
│   ├── hooks/              # 사용자 정의 Hooks (useTheme, useToasts)
│   ├── i18n/               # 국제화 (2개 언어: 中文 / English)
│   ├── lib/                # 유틸리티 (프리셋 관리, 출력 추정, Tauri 호출)
│   ├── App.tsx             # 메인 앱 컴포넌트
│   ├── main.tsx            # 진입점
│   ├── types.ts            # TypeScript 타입 정의
│   └── index.css           # 스타일 (Tailwind CSS 4)
├── src-tauri/              # Rust 백엔드
│   ├── src/                # Rust 소스
│   │   ├── commands.rs     # Tauri 명령 등록
│   │   ├── jobs.rs         # 작업 큐, FFmpeg 인수, 진행/이벤트
│   │   ├── inspect.rs      # ffprobe 기반 전체 미디어 검사
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