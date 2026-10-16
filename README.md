# METANOIA — Frontend

Frontend cho hệ thống **METANOIA** — nền tảng quản lý dự án thông minh với AI decompose tasks.

## Tech Stack

- **React 19** + **TypeScript**
- **Vite** (build tool, HMR)
- **React Router** (routing)
- CSS Modules / vanilla CSS theo page

## Cấu trúc

```
src/
├── auth/          # Auth context, storage, post-login redirect
├── components/    # Shared components (MetanoiaLogo, ...)
├── hooks/         # Custom React hooks
├── layouts/       # AuthLayout, SiteLayout
├── lib/           # api-client (REST wrapper cho Backend)
├── pages/
│   ├── copilot/   # AI Copilot
│   ├── dashboard/ # Dashboard
│   ├── landing/   # Landing page
│   ├── login/     # Đăng nhập (Google OAuth)
│   ├── onboarding/
│   ├── planning/  # Manual task decomposition
│   ├── pricing/
│   ├── project-detail/
│   ├── projects/  # Danh sách dự án
│   ├── register/  # Đăng ký
│   └── schedule/  # Lịch (Google Calendar style)
├── router/        # ProtectedRoute
├── App.tsx
└── main.tsx
```

## Setup

```bash
npm install
npm run dev          # dev server (http://localhost:5173)
npm run build        # production build
npm run preview      # preview build
npm run lint         # ESLint
```

## Environment

Tạo file `.env` ở root (xem `.env.example` nếu có):

```env
VITE_API_URL=https://your-backend.example.com
VITE_AI_API_URL=https://your-ai-service.example.com
VITE_GOOGLE_CLIENT_ID=...
```

## Backend API

Base URL: `VITE_API_URL`

Các endpoint chính:

| Method | Path | Mô tả |
|--------|------|-------|
| `POST` | `/api/Auth/google` | Login bằng Google ID token |
| `POST` | `/api/Auth/refresh` | Refresh access token |
| `GET`  | `/api/me` | Lấy thông tin user hiện tại |
| `GET`  | `/api/projects` | Danh sách dự án |
| `POST` | `/api/projects` | Tạo dự án mới |
| `GET`  | `/api/projects/{id}` | Chi tiết dự án |
| `POST` | `/api/projects/{id}/tasks` | Tạo task trong dự án |
| `POST` | `/api/tasks/{id}/subtasks` | Tạo subtask |
| `GET`  | `/api/clients` | Danh sách khách hàng |

## License

Private — Capstone GFA26SE116.
