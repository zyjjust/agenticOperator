// Canonical entity types tracked across the workflow. Each value matches
// what RAAS / agents put into envelope.entity_type fields, and is the
// route segment under /entities/[type]/[id].

export const ENTITY_TYPES = ['JobRequisition', 'JobPosting', 'Candidate'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(s: string): s is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(s);
}

/** UI display label per type. */
export const ENTITY_LABELS: Record<EntityType, string> = {
  JobRequisition: '需求',
  JobPosting: 'JD',
  Candidate: '候选人',
};
