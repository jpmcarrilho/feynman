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
   ```bash
   cd web
   npm install
   ```

2. **Database Setup**:
   Initialize the SQLite database with Prisma.
   ```bash
   npx prisma db push
   ```

3. **Environment Variables**:
   Ensure you have a `.env` file in the `web/` directory containing your Google AI API Key (required for Gemini):
   ```env
   GOOGLE_API_KEY=your_api_key_here
   ```

4. **Run the Development Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Data Ingestion & Crawling

Data is generated through a crawler pipeline (see `README_CRAWLER.md` in the root). 

- `check_auth.js`: A helper script in the root directory to verify your authentication status with the MIT learn platform via Puppeteer. You can configure Chrome paths via `CHROME_PATH` and `CHROME_PROFILE_DIR` environment variables if needed.
- `web/src/scripts/seed.ts`: Uses the services in `ingest.ts` to populate the SQLite database with the crawled courses, topics, and exercises.

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
