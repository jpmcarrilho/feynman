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

## Data Ingestion, Seeding & Utilities

Data is generated through a crawler pipeline (see `README_CRAWLER.md` in the root).

*   `check_auth.js`: A helper script in the root directory to verify your authentication status with the MIT learn platform via Puppeteer. You can configure Chrome paths via `CHROME_PATH` and `CHROME_PROFILE_DIR` environment variables if needed.
*   **Seeding the Database**: To populate your local SQLite database with crawled courses, topics, and exercises, make sure the crawl records exist under `../MIT_Learn_Courses/` and run:
    ```bash
    npx tsx src/scripts/seed.ts
    ```
*   **LaTeX Format Fixes**: If there are unescaped LaTeX symbols/formulas in your question prompts, run the cleanup utility:
    ```bash
    npx tsx fix-latex-prompts.ts
    ```
*   **Image Alignment Fixes**: If some exercise explanations contain external images that are not correctly aligned/rendered in questions, run:
    ```bash
    npx tsx fix-images.ts
    ```

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
*   **[Feynman & MAGI Policy Simulator (FEYNMAN_MAGI_DESIGN.md)](FEYNMAN_MAGI_DESIGN.md)**: Vision and specs on shareable SaaS course workspaces and multi-agent econometric policy debate simulations ("MAGI").
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
