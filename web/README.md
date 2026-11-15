# DEDP Study Application

This is a Next.js application built to help students study for MIT's Data, Economics, and Development Policy (DEDP) MicroMasters courses. It provides an interactive flashcard system, AI-assisted explanations, and study analytics.

## Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) (App Router)
- **Language**: TypeScript
- **Database**: SQLite, managed via [Prisma ORM](https://www.prisma.io/)
- **AI Integration**: Vercel AI SDK (`@ai-sdk/google`) with Gemini models (e.g., `gemini-2.0-flash`)
- **Styling**: Tailwind CSS & [shadcn/ui](https://ui.shadcn.com/)

## Architecture

- **`src/app/`**: Contains the Next.js routes and Server Actions (`actions.ts`). Server Actions handle database operations and AI generations (like explaining mistakes or generating new questions).
- **`src/components/`**: UI components, including the main `StudyInterface` and `Flashcard` components.
- **`src/hooks/`**: Custom React hooks, such as `useLiveAPI` for real-time voice interactions.
- **`src/services/`**: Internal services for data ingestion (e.g., `ingest.ts` for parsing PDFs, CSVs, and Markdown).
- **`prisma/`**: Contains the `schema.prisma` file defining the data model (Study Sessions, Exercises, Topics, etc.).

## Setup & Running

1. **Install Dependencies**:
   If you are starting from the parent directory of the repository:
   ```bash
   cd web
   npm install
   ```
   *(If you opened the `web` folder directly as your workspace, you are already inside it; just run `npm install`).*

2. **Environment Variables**:
   Create a `.env` file in the root of the `web` directory by copying the example template:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and configure the following parameters:
   *   `GOOGLE_API_KEY`: Your Google AI Studio Gemini API key.
   *   `APP_PASSCODE`: A secure passcode used to log into the application.
   *   `DATABASE_URL`: Set to `file:./dev.db` for local SQLite development.

3. **Database Setup**:
   Initialize the SQLite database schema with Prisma:
   ```bash
   npx prisma db push
   ```

4. **Run the Development Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser and log in using the `APP_PASSCODE` you set in your `.env`.

## Phone access

The "Phone access" card on `/spaces` runs `tailscale serve --bg --https=443 --yes localhost:<port>` (on) and `tailscale serve --https=443 off` (off) for the app's port (`PORT`, default 3000), shows the state, and when on shows the `https://<mac>.<tailnet>.ts.net` address with a QR code. Serve reaches only devices on your own tailnet; `tailscale funnel` (public internet) is never used. The passcode is still required on the phone.

One-time setup (you do this yourself):
1. Install Tailscale on the Mac (tailscale.com/download or the Mac App Store) and sign in; install it on the phone with the same account. For the standalone app, enable its command-line integration in its settings.
2. In the Tailscale admin console, enable MagicDNS and HTTPS certificates.
3. The first time, Tailscale may need a one-time approval. If the switch reports this, run `tailscale serve --bg --https=443 localhost:3000` in Terminal (use your port), open the link it prints, approve, then press Refresh on the card.

The switch only works from the Mac itself (open the app at `localhost`); on the phone the card shows the state and address only. "Tailscale not running" means the Tailscale app is closed or signed out on the Mac. If the Tailscale binary is somewhere unusual, set `TAILSCALE_BIN` to its path.

**Easiest way to start everything: `scripts/run.sh`** (from the repo root; `--prod` for the production build, `--dry-run` to preview). It finds the Mac's `.ts.net` address, passes it to the app as `PHONE_ACCESS_HOST`, binds to 127.0.0.1, and prints the addresses for the Mac and the phone. The port is the first free one from 3000 upwards (something else on 3000 is left alone; `PORT=3005` forces a port, `FIRST_PORT=4000` moves the search). If the app already runs from this folder it says so instead of starting a second copy. `tailscale serve` forwards the phone address to one port, so when the app lands on another port the script warns what the phone would show; `--serve` points the phone address at the chosen port, as does the Phone access switch on `/spaces`. Without `--serve` the script never changes the Tailscale setup.

`PHONE_ACCESS_HOST=<mac>.<tailnet>.ts.net` adds that name to `serverActions.allowedOrigins` and `allowedDevOrigins`. With `next dev` it is required for the phone: without it Next answers 403 to every `/_next/*` request that carries the phone's `Origin` ("Blocked cross-origin request to Next.js dev resource" in the log), the page's scripts do not run and the login form does nothing. With a production build it is only needed if forms and buttons on the phone fail with "Invalid Server Actions request" in the server log: Next accepts a server action when the request's `Origin` equals its `Host` (or `X-Forwarded-Host`), and Tailscale's documentation does not say which `Host` Serve forwards. Set it before `next build` / `next start` / `next dev`, because `next.config.ts` reads it when it is loaded (`scripts/run.sh` does this).

## Run as a background service

A launchd user agent (`com.feynman.studyhub`) can run the app in the background. It starts at login and restarts if it crashes. It serves a production build bound to `127.0.0.1` on port 3000 (or `PORT`).

From the repo root:
```bash
scripts/launchd/install.sh --dry-run   # preview: runs the checks, prints the plist, builds nothing
scripts/launchd/install.sh             # builds web/ and loads the agent
```
The install script needs `web/.env` (with `APP_PASSCODE` and `GOOGLE_API_KEY`) and `web/node_modules`, and it refuses to run if port 3000 is already in use.

- **Stop or uninstall:** `scripts/launchd/uninstall.sh`. Stop the service before running `npm run dev` on the same port and database.
- **Update:** after pulling new code or changing the Node version, run `scripts/launchd/uninstall.sh` and then `scripts/launchd/install.sh` again, so the build and the plist pick up the change.
- **Logs:** `~/Library/Logs/feynman-studyhub/out.log` and `err.log`. Uninstall keeps them.

Warning: the service opens the real database (`web/dev.db`), so back it up before the first install.

## Data Ingestion & Utilities

Course files are uploaded through the app (new studyspace, or Resources, Add files). Files you saved from a course yourself can live in
`../MIT_Learn_Courses/` (git-ignored, never committed).

*   **Seeding the Database** (older, pre-studyspace courses only): `npx tsx src/scripts/seed.ts` reads the files under `../MIT_Learn_Courses/`.
*   **Exercise files with multi-part problems**: `npx tsx src/scripts/build-edx-exercises.ts <course dir> <output dir>` builds upload files from a course folder you saved (see the header of the script).
*   **Week labels**: `DATABASE_URL=file:./dev.db npx tsx src/scripts/relabel-weeks.ts <course id> <names.json>` labels the topics of a studyspace with the course weeks (see `src/lib/weekLabels.ts`).

## Deployment (Google Cloud Run)

This repository includes a script to easily build and deploy the workspace as a Next.js service on **Google Cloud Run**:

```bash
node deploy-cloud-run.js
```

This deployment script will:
1. Load secrets (`GOOGLE_API_KEY`, `APP_PASSCODE`) from your local `.env` securely.
2. Package the application and submit it to Google Cloud Build.
3. Automatically run Prisma schema generation (`prisma generate && next build`) during deployment.
4. Deploy a containerized instance of the Feynman Study Hub to `us-central1` with unauthenticated access enabled.

## Core System Architecture

To understand the core designs, algorithms, and models powering our DEDP Study Hub, see the following dedicated architectural guides:

*   **[Core Platform & Question Generation Architecture (QUESTION_GENERATION.md)](QUESTION_GENERATION.md)**: Details on the Adaptive Performance-based Sourcing Mix, Iterative Background AI Generator, Dynamic Context Enrichment and Table Reconstruction, Timed Mock Exam Simulator, Proportional "One-Wrong-Cancels-One-Right" Partial Credit Scoring, Professor Cognitive-Trap Diagnosis Engines, Socratic Curriculums Timeline Schedulers, and Micro-Meso-Macro analytics tracking.
*   **[Ideas for GraphRAG Ingestion Pipelines (IDEAS_GRAPH_RAG.md)](IDEAS_GRAPH_RAG.md)**: Conceptual specifications for expanding database nodes/edges to construct high-fidelity relational knowledge graphs for grounding AI responses.

## Testing

Run unit tests via Vitest:
```bash
npm run test
```

Run E2E tests via Playwright:
```bash
npm run test:e2e
```

## Changelog

- Fixed UI bugs in the Flashcard component ensuring that long option texts properly wrap (using `whitespace-normal` for Buttons and `min-w-0` for flex containers).
- Created a database script (`fix-latex-prompts.ts`) to fix unescaped LaTeX formatting in specific question prompts.
- Enhanced Voice Tutor integration to correctly appear regardless of answer correctness, and added automatic microphone muting when sending text messages.
