# 🎓 Feynman DEDP Study Platform
### *Personal Socratic AI Tutor & Adaptive Workspace for MIT DEDP MicroMasters*

The **Feynman DEDP Study Platform** is a highly personalized, adaptive, and visually rich educational workspace designed to help students master **MIT’s Data, Economics, and Development Policy (DEDP) MicroMasters** curriculum. 

Instead of passive, cookie-cutter cramming, the platform transforms static textbooks, lecture slide decks, and transcripts into an interactive, **hands-free Socratic learning environment**. It utilizes sophisticated AI reasoning, real-time bidirectional voice tutoring, performance-based adaptive question mixes, and detailed econometric diagnostics to identify and bridge your critical conceptual gaps.

---

## 🚀 Key Features & Visual Walkthrough

### 1. Secure Passcode-Gated Entry
A clean, secure, and physics-themed entrance gates access to your personal study workspace. Simply enter your encrypted passcode to authenticate and retrieve your personalized learning metrics.

<p align="center">
  <img src="web/public/screenshots/landing.png" width="90%" alt="Passcode Entrance Gate" />
</p>

---

### 2. Socratic Study Workspace & Hands-Free Voice Panel
The core study interface features an interactive, keyboard-navigable flashcard engine supporting **fully typeset LaTeX mathematical formulas** and clean formatting.
* **Talk to the Professor**: On the right, a real-time, hands-free voice interface connects you to a virtual Richard Feynman who listens to your reasoning, dynamically explains concepts, and guides you to the correct answer.
* **Session Sidebar**: Keep track of your progress, scores, and active sessions on the left.

<p align="center">
  <img src="web/public/screenshots/study-main.png" width="90%" alt="Main Study Interface" />
</p>

---

### 3. Adaptive Session Tuner & Filter Controls
Before starting a session, configure the optimal focus for your study.
* **Practice vs. Timed Exam**: Study at your own pace with AI assistance, or test yourself under strict exam conditions.
* **Sourcing Mix**: Combine ingested historical questions with fresh, AI-generated variants modeled after MIT's cognitive traps.
* **Retrieval Focus**: Select customized proportions for your syllabus focus: *Remedial Sprint* (focusing on weak areas), *Fresh Exploration* (unseen topics), or *Maintenance Review* (spaced review of mastered topics).

<p align="center">
  <img src="web/public/screenshots/study-config.png" width="90%" alt="Study Session Config" />
</p>

---

### 4. Recharts-Powered Performance Analytics
An analytical dashboard tracks your progress across **700+ practice exercises** and multiple courses.
* **Global AI Learning Diagnosis**: An executive diagnostic report deconstructs your learning profile, pinpointing exact conceptual gaps (e.g., *Leader Effects in Autocracies vs. Democracies*, *Nathan Nunn's 2008 Slave Trade Robustness Analysis*, or *Intra-Cluster Correlation in Clustered Randomized Controlled Trials*).
* **Interactive Accuracy Heatmaps**: Color-coded calendars map your accuracy percentage across all weeks and modules. Clicking on any week drills down into subtopic performance and lists direct links to related slides and transcripts in the workspace.

<p align="center">
  <img src="web/public/screenshots/study-analytics.png" width="90%" alt="Analytics Dashboard" />
</p>

---

### 5. AI Socratic Academic Planner
Interact with an AI Academic Advisor to design a custom, multi-day curriculum. Simply type in your availability (e.g., *"I have 2 hours a day from Tuesday to Friday"*), and the planner generates an optimal, step-by-step study schedule mapped to your weakest categories.

<p align="center">
  <img src="web/public/screenshots/study-plan.png" width="90%" alt="Socratic Study Planner" />
</p>

---

### 6. Course Resources Registry & Feynman Guides
The Resources tab catalogues all ingested course assets:
* **PDF Lecture Slides & Transcripts**: Click on any document or highlighted quote to open the source materials in the course visualizer.
* **Feynman Study Guides**: Generate concept-demystifying, highly intuitive lecture summaries that use analogies, diagrams, and step-by-step model breakdowns to explain the core intuition behind complex economic models.

<p align="center">
  <img src="web/public/screenshots/study-resources.png" width="90%" alt="Syllabus Resources Registry" />
</p>

---

## 🛠️ Tech Stack & Architecture

* **Frontend**: React 19, [Next.js 16](https://nextjs.org/) (App Router), Tailwind CSS 4, and [shadcn/ui](https://ui.shadcn.com/)
* **Database & ORM**: SQLite database managed with [Prisma ORM](https://www.prisma.io/)
* **AI Integration**: Vercel AI SDK (`ai`), `@ai-sdk/google` using Google Gemini models (`gemini-2.0-flash`, `gemini-1.5-pro`)
* **Interactive Charts**: Responsive data visualization powered by [Recharts](https://recharts.org/)
* **Formulas & Markdown**: LaTeX mathematical formatting typeset via [KaTeX](https://katex.org/)
* **Data Ingestion**: Custom Puppeteer crawler and parser scripts for unzipping, reading, and indexing PDFs/CSVs/Markdowns.

---

## 📂 Project Structure

```
dedp/
├── MIT_Learn_Courses/         # Ingested syllabus slide PDFs, transcripts, and metadata
├── web/                       # The Next.js web application
│   ├── prisma/                # SQLite database schema definition (schema.prisma)
│   ├── public/                # Static assets (SVGs, icons, screenshots)
│   ├── src/
│   │   ├── app/               # Server Actions, layout, and page routes
│   │   ├── components/        # React interface widgets (StudyInterface, Charts, Forms)
│   │   ├── hooks/             # Custom React hooks (Live API websockets, timers)
│   │   ├── services/          # Prisma database service layers & ingestion handlers
│   │   └── scripts/           # Seeding, cleanup, and validation helpers
│   └── package.json           # Web app configuration and script commands
├── package.json               # Parent directory configuration
└── check_auth.js              # MIT crawler authentication helper
```

---

## ⚡ Quick Setup

### 1. Install Dependencies
Navigate into the `web` folder and install NPM packages:
```bash
cd web
npm install
```

### 2. Configure Environment Variables
Create a local `.env` file from the example template:
```bash
cp .env.example .env
```
Open `.env` and set:
* `GOOGLE_API_KEY`: Your Google AI Studio Gemini API key.
* `APP_PASSCODE`: A secure passcode used to log into the application.
* `DATABASE_URL`: Set to `file:./dev.db` for local SQLite development.

### 3. Initialize Database
Apply database schemas and migrate:
```bash
npx prisma db push
```

### 4. Seed Course Data
Populate your local database with crawled topics, slides, and exercises:
```bash
npx tsx src/scripts/seed.ts
```

### 5. Run the Server
Launch the development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser and log in with your `APP_PASSCODE`.

---

## 📖 Deep Architectural Specs

For deep dives into the algorithms, features, and engineering designs powering this application, read our dedicated specification files inside the `web` directory:
* **[QUESTION_GENERATION.md](web/QUESTION_GENERATION.md)**: Details on the Adaptive Sourcing Mix, Iterative Background Generation, Cognitive-Trap Diagnosis, "One-Wrong-Cancels-One-Right" Scoring, and Socratic Schedulers.
* **[FEYNMAN_MAGI_DESIGN.md](web/FEYNMAN_MAGI_DESIGN.md)**: Vision on shareable workspaces and Multi-Agent Econometric Policy Debates ("MAGI").
* **[IDEAS_GRAPH_RAG.md](web/IDEAS_GRAPH_RAG.md)**: specs for relational knowledge graph ingestion pipelines using GraphRAG.

---

## 🛡️ License & Safety

* **MIT Licensed**: Free for educational and personal use.
* **Zero Secrets Committed**: This repository has undergone a strict security audit and is guaranteed free of hardcoded API keys, active passwords, or personal credentials.

---

### *“Understand everything. Simplify anything.”* — Richard Feynman
