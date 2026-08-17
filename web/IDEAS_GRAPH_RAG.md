# Ideas: GraphRAG Ingestion Pipeline & Policy Debate Simulator

This document provides a highly specific, codebase-aware blueprint for implementing a **GraphRAG Ingestion Pipeline** and **Policy Debate Simulator** inside the DEDP / Feynman platform. 

---

## 1. Schema Extensions (`web/prisma/schema.prisma`)
To support relation-aware retrieval, we can extend the SQLite schema with two lightweight tables. Add these to your Prisma schema:

```prisma
model ConceptNode {
  id          String         @id @default(uuid())
  name        String         @unique // e.g., "Gini Coefficient", "RCTs", "Capital Flight"
  type        String         // e.g., "concept", "policy", "metric", "formula"
  description String?        // Synthesized description of the concept
  sourceTopicId String?      // Optional reference back to the original Topic
  topic       Topic?         @relation(fields: [sourceTopicId], references: [id])
  
  outgoingRelations ConceptRelation[] @relation("SourceNode")
  incomingRelations ConceptRelation[] @relation("TargetNode")
}

model ConceptRelation {
  id               String      @id @default(uuid())
  sourceId         String
  targetId         String
  relationshipType String      // e.g., "risk_of", "verifies", "reduces", "influences"
  explanation      String?     // A short sentence explaining why A -> B

  sourceNode       ConceptNode @relation("SourceNode", fields: [sourceId], references: [id], onDelete: Cascade)
  targetNode       ConceptNode @relation("TargetNode", fields: [targetId], references: [id], onDelete: Cascade)

  @@unique([sourceId, targetId, relationshipType])
}
```

---

## 2. Extraction Pipeline (`web/src/services/ingest.ts`)
Using Vercel AI SDK and Gemini, we can define a structured output extractor that parses newly ingested lecture text or policy documents into entities and relation-triplets.

```typescript
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';

export interface ExtractedGraph {
  nodes: Array<{
    name: string;
    type: 'concept' | 'policy' | 'metric' | 'formula';
    description: string;
  }>;
  relations: Array<{
    source: string;
    target: string;
    relationshipType: string;
    explanation: string;
  }>;
}

export async function extractKnowledgeGraph(text: string): Promise<ExtractedGraph> {
  const prompt = `You are an expert economic and scientific researcher. 
Analyze the following text and extract key concepts, formulas, policies, and their directed relationships.

Text to analyze:
"${text.substring(0, 5000)}" // Constrained to prevent context exhaustion
`;

  const { object } = await generateObject({
    model: google('gemini-2.0-flash'), // extremely fast and accurate for structured extraction
    schema: z.object({
      nodes: z.array(z.object({
        name: z.string().describe("The name of the concept, policy, or metric (e.g., 'Gini Coefficient')"),
        type: z.enum(['concept', 'policy', 'metric', 'formula']),
        description: z.string().describe("A brief, clear definition of the concept")
      })),
      relations: z.array(z.object({
        source: z.string().describe("The source concept name"),
        target: z.string().describe("The target concept name"),
        relationshipType: z.string().describe("Verbs like 'risk_of', 'reduces', 'influences', 'verifies'"),
        explanation: z.string().describe("A 1-sentence explanation of why the source influences the target")
      }))
    }),
    prompt,
  });

  return object;
}
```

---

## 3. Retrieval Loop (GraphRAG Context)
When a student talks to the `VoiceHub` or an agent debates in the `MAGI Arena`, we query the database to find the semantic neighborhood of keywords.

```typescript
import { prisma } from '@/lib/db';

export async function getGraphRAGContext(keywords: string[]): Promise<string> {
  // 1. Fetch matching nodes
  const matchedNodes = await prisma.conceptNode.findMany({
    where: {
      name: { in: keywords }
    },
    include: {
      outgoingRelations: {
        include: { targetNode: true }
      },
      incomingRelations: {
        include: { sourceNode: true }
      }
    }
  });

  if (matchedNodes.length === 0) return "";

  // 2. Build a rich context string
  let contextText = "### GraphRAG Concept Neighborhood:\n";
  
  for (const node of matchedNodes) {
    contextText += `- **${node.name}** (${node.type}): ${node.description || 'No description'}\n`;
    
    // Add outgoing relations
    for (const rel of node.outgoingRelations) {
      contextText += `  * Influences: **${rel.targetNode.name}** via relation \`${rel.relationshipType}\` (${rel.explanation})\n`;
    }
    
    // Add incoming relations
    for (const rel of node.incomingRelations) {
      contextText += `  * Influenced by: **${rel.sourceNode.name}** via relation \`${rel.relationshipType}\` (${rel.explanation})\n`;
    }
  }

  return contextText;
}
```

---

## 4. Grounding the World Model / Debate Simulator
With GraphRAG context, you can safely initialize the simulation:
- **Zero Hallucination**: Agents are fed the exact sub-graph retrieved for the proposed policy.
- **Implicit Learning**: If a student types a custom policy, the simulator automatically uses the economics formulas ingested from the DEDP coursework.
- **Easy APIs**: You can expose a simple POST `/api/ingest` that takes any PDF, extracts the concepts using `extractKnowledgeGraph`, and saves them to SQLite in seconds.
