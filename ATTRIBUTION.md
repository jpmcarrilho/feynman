# Attribution of course material

The Feynman study platform helps a student study courses they are enrolled in. The studyspaces built for the author's own study use
material from the following MITx courses. The material belongs to its authors; this project claims no rights over it.

| Course | Title | Provider | Run used | Course page (sign-in needed) |
|---|---|---|---|---|
| 14.740x | Foundations of Development Policy | MITx (MIT Learn) | 3T2026 | https://courses.learn.mit.edu/learn/course/course-v1:MITxT+14.740x+3T2026 |
| 14.750x | Political Economy and Economic Development | MITx (MIT Learn) | 2T2026 | https://courses.learn.mit.edu/learn/course/course-v1:MITxT+14.750x+2T2026 |
| JPAL102x | Designing and Running Randomized Evaluations | MITx / J-PAL (MIT Learn) | 2T2026 | https://courses.learn.mit.edu/learn/course/course-v1:MITxT+JPAL102x+2T2026 |

The course teams (the faculty who wrote and teach each course) are named on the course pages above. The crawled files do not record
the faculty names, so they are not repeated here. Add them from the course pages when you know them.

## What is used, and how it is referenced

- **Lecture transcripts, slides, readings and exercises** come from the author's own enrolled account and are used for personal,
  non-commercial self-study. The imported exercises keep the course's own wording and answers.
- **Questions written by the app** (generated questions, starter questions and multi-part problems) are derived from that material.
  They are marked as AI-written wherever they are shown.
- **In the app** every question and the Resources page name the course (code, title, provider, run) and link its course page
  (`web/src/lib/attribution.ts`, shown by `SourceCredit`). A question's module, class and kind (for example "Week 05 · Insurance ·
  Homework") show which part of the course it comes from.
- **Papers, datasets and handouts** that the course links (journal articles, working papers, the assignment handouts) belong to their
  authors and publishers. The app only reads them for study; it does not republish them.

## Where the files are

The course files (transcripts, slides, exercises, readings, datasets) live in `MIT_Learn_Courses/<course>/` on the student's own
machine. They are git-ignored and are not part of this repository, and this repository contains no tool for downloading them.

## Terms

The course content is not covered by this repository's software licence. The repository `LICENSE` (Part 2) asks that any derivative
notes and questions keep attribution to MIT, MIT OpenCourseWare / MITx and the faculty authors, and that use stays personal and
non-commercial. The MITx Online Honor Code applies to the graded assignments: do not publish answers to graded work.

MIT, MITx, MIT Learn and J-PAL are trademarks of their owners, used here only to say where the material comes from.

## Takedown

If MIT, J-PAL, a course author or a publisher objects to any reference or file in this repository, open an issue and it will be removed
promptly.
