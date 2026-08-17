# 📓 Architectural Refactoring & 10x Product Blueprint

This document details the modularization plan for the current codebase and explores the strategic design of a **10x Future Version** of the Feynman MIT MicroMasters Study Companion.

---

## 🛠️ Phase 1: Codebase Modularization Plan (Current App)

Currently, the application contains two monolithic code hubs (`src/app/actions.ts` at ~1,900 lines and `src/components/features/StudyInterface.tsx` at ~1,750 lines). To improve maintainability, speed up compilation times, and prevent layout calculation or state re-rendering bottlenecks, we propose the following modularization:

### 1. Backend Service Separation (`src/services/`)
We will move complex, business-heavy logic out of Next.js Server Actions in `src/app/actions.ts` and into domain-driven service files. Actions will serve strictly as thin entry-points.

*   **`src/services/sessionService.ts`**:
    *   *Extract*: `createStudySession`, `finishStudySession`, `deleteStudySession`, `logAnswer`.
    *   *Role*: Handles student session progress, metrics tracking, and database logging.
*   **`src/services/diagnosticService.ts`**:
    *   *Extract*: `generateExamDiagnosis`, `generateSessionSummary`, LaTeX rendering pre-processors.
    *   *Role*: Focuses on AI-prompt compilers and LaTeX formatting.
*   **`src/services/studyPlanService.ts`**:
    *   *Extract*: `generateStructuredStudyPlan`, `saveAndDeployStudyPlan`, `getStudyPlans`, `deleteStudyPlan`.
    *   *Role*: Manages structured syllabus planning and JSON roadmap formatting.

### 2. Frontend Component Decomposition (`src/components/features/`)
To resolve heavy React re-renders triggered on every state mutation (e.g. countdown timer ticks, sidebars collapsing) inside `StudyInterface.tsx`, we will decompose it:

*   **State Separation (`src/hooks/useStudySession.ts`)**:
    *   Extract active session state, countdown timers, draft answers, index tracking, and sidebar toggle variables into a custom, type-safe hook.
*   **Sub-component Isolation (`src/components/features/study/`)**:
    *   `StudyHeader.tsx`: Handles navigation tab triggers, fixed floating logo spacer padding, and sidebar collapse controls.
    *   `ActiveSessionPanel.tsx`: Houses the countdown clock, LaTeX card views, and navigation pagination.
    *   `EmptyStatePanel.tsx`: Displays the unified "Create Session" configurator and historical session cards.
    *   `DiagnosticReportView.tsx`: Displays post-exam charts, accuracy metrics, and the scrollable AI diagnostic report.

---

## 🚀 Phase 2: The 10x Future Version Product Blueprint

To transition this application from a useful study dashboard into an **indispensable, category-defining, immersive cognitive training system** for MIT-level coursework, we outline four paradigm-shifting upgrades:

### 1. Multi-Modal Deep Graph RAG (Knowledge Graphs)
*   **The Status Quo**: Current RAG retrieves static, text-chunked transcripts and slide notes based on simple vector searches.
*   **The 10x Upgrade**: Construct a **Dynamic Concept Dependency Graph** representing the entire MIT syllabus as a semantic web:
    *   *Nodes*: Core economic concepts (e.g. *Instrumental Variables*, *Omitted Variable Bias*, *Local Average Treatment Effect*).
    *   *Edges*: Directed, mathematical prerequisite dependencies (e.g., *Instrumental Variables* requires *Endogeneity*, which requires *Ordinary Least Squares*).
    *   *AI-Guided Remediation*: When the system detects a drop in accuracy on advanced questions, the graph engine automatically traverses back to the lagging prerequisite nodes. The tutor will then dynamically generate an intuitive, customized remedial lesson path with responsive visual node charts.

### 2. Dual-Stream Shared Canvas Visualizer (Gemini Live Audio-Video API)
*   **The Status Quo**: Audio voice tutoring is a blind, voice-only loop. Students must describe equations and models verbally.
*   **The 10x Upgrade**: Establish a **Shared Real-Time Virtual Chalkboard**:
    *   Integrate Gemini's Live Audio-Video API to stream both a canvas stream and bidirectional high-fidelity voice.
    *   Students can solve math models, draw graphs, or annotate slides on a digital blackboard.
    *   The AI Professor analyzes the whiteboard feed in real-time, speaks directly to the student, and physically interacts on the screen: *"Wait, look at your budget constraint line. You drew it with a positive slope, but utility maximization requires a negative slope. Let's redraw it together."*

### 3. SM-17 Cognitive Spaced Repetition (AI-Drills)
*   **The Status Quo**: Students initiate study sessions manually, resulting in flat, disjointed retention curves.
*   **The 10x Upgrade**: Introduce a **Cognitive Decay Tracking Engine** based on advanced spaced-repetition algorithms:
    *   Track student concept mastery by analyzing response latency, question complexity, and step-by-step mathematical reasoning.
    *   Predict the exact day a student's retention of a model drops below 90%.
    *   Automatically queue up 5-minute cognitive workouts and push them via mobile, email, or WhatsApp, guaranteeing 95%+ permanent retention of complex academic material.

### 4. Interactive Peer-Group Debate & Roleplay Simulation
*   **The Status Quo**: The interface is a private, one-on-one tutor session.
*   **The 10x Upgrade**: Introduce **Virtual Collaborative Seminars**:
    *   A student enters a seminar room with an AI Professor and 3 virtual AI peer students (with distinct cognitive learning personas, e.g., "The Rigorous proof-seeker", "The Impatient policy builder", "The Confused Intuitive").
    *   The professor poses a complex public policy problem. The virtual peers debate, make economic reasoning mistakes, or propose alternative models.
    *   The student's task is to step in, identify logical flaws in their peers' arguments using the Feynman Technique, and defend their mathematical models, simulating real graduate-level academic debate!
