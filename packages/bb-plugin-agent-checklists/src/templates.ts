import type { ChecklistTemplate } from "./types";

const softwareDeliverySteps = [
  ["understand-request", "Understand the request", "Confirm the desired behavior, constraints, and acceptance criteria."],
  ["inspect-repository", "Inspect the repository", "Read the relevant code, tests, documentation, and local instructions."],
  ["define-implementation", "Define the implementation", "Choose the smallest coherent implementation and identify risks."],
  ["make-change", "Make the change", "Implement the requested behavior while preserving unrelated work."],
  ["update-tests", "Add or update tests", "Cover the behavior and the important edge cases."],
  ["run-validation", "Run validation", "Run the relevant typechecks, tests, builds, and static checks."],
  ["perform-local-qa", "Perform local QA", "Exercise the user-visible path and inspect the result for regressions."],
  ["prepare-handoff", "Prepare the handoff", "Summarize the change, validation, remaining risks, and next actions."],
] as const;

const researchSteps = [
  ["clarify-question", "Clarify the question", "Define the question, audience, scope, and required output."],
  ["gather-sources", "Gather sources", "Find relevant primary and authoritative sources for the question."],
  ["check-source-quality", "Check source quality", "Separate direct evidence from inference and note important limitations."],
  ["organize-findings", "Organize findings", "Group the evidence into a clear structure before drafting."],
  ["draft-answer", "Draft the answer", "Write a complete answer that directly addresses the question."],
  ["simplify-technical-english", "Simplify the technical English", "Use clear, direct language and an ASD-STE100-style technical writing approach."],
  ["check-facts-and-citations", "Check facts and citations", "Verify claims, dates, links, quotations, and source support."],
  ["produce-readable-output", "Produce the readable output", "Deliver a well-structured final document with useful headings and next steps."],
] as const;

function makeTemplate(
  id: string,
  name: string,
  description: string,
  steps: readonly (readonly [string, string, string])[],
): ChecklistTemplate {
  const now = Date.now();
  return {
    id,
    name,
    description,
    defaultMode: "automatic",
    isBuiltIn: true,
    steps: steps.map(([stepId, title, stepDescription], position) => ({
      id: stepId,
      position,
      title,
      description: stepDescription,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export const BUILT_IN_TEMPLATES: ChecklistTemplate[] = [
  makeTemplate(
    "software-delivery",
    "Software delivery",
    "Carry a coding task from understanding through validation and handoff.",
    softwareDeliverySteps,
  ),
  makeTemplate(
    "research-to-technical-document",
    "Research to technical document",
    "Turn research into a clear, source-supported technical document.",
    researchSteps,
  ),
];
