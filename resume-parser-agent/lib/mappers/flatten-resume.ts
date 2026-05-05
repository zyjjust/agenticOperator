// 把 4 对象嵌套压成 plain text，喂给 RoboHire /match-resume 的 resume 字段

import type { ResumeProcessedData } from '../inngest/client';

export function flattenResumeForMatch(data: ResumeProcessedData): string {
  const { candidate, candidate_expectation, resume, runtime } = data;
  const lines: string[] = [];

  if (candidate.name) lines.push(`姓名 / Name: ${candidate.name}`);
  if (candidate.email) lines.push(`Email: ${candidate.email}`);
  if (candidate.current_location) lines.push(`Location: ${candidate.current_location}`);
  if (candidate.highest_acquired_degree)
    lines.push(`Highest Degree: ${candidate.highest_acquired_degree}`);
  if (candidate.work_years != null) lines.push(`Work Years: ${candidate.work_years}`);

  if (runtime.current_title || runtime.current_company) {
    lines.push(
      `Current: ${runtime.current_title ?? '(unknown)'} @ ${runtime.current_company ?? '(unknown)'}`
    );
  }

  if (candidate.skills.length > 0) {
    lines.push(`Skills: ${candidate.skills.join(', ')}`);
  }

  if (resume.summary) {
    lines.push('');
    lines.push('Summary:');
    lines.push(resume.summary);
  }

  if (resume.work_history && resume.work_history.length > 0) {
    lines.push('');
    lines.push('Work Experience:');
    for (const w of resume.work_history) {
      const range = `${w.startDate ?? '?'} – ${w.endDate ?? 'present'}`;
      lines.push(`- ${w.title ?? ''} at ${w.company ?? ''} (${range})`);
      if (w.description) lines.push(`  ${w.description}`);
    }
  }

  if (resume.education_history && resume.education_history.length > 0) {
    lines.push('');
    lines.push('Education:');
    for (const e of resume.education_history) {
      lines.push(
        `- ${e.degree ?? ''} in ${e.field ?? ''}, ${e.institution ?? ''} (${e.graduationYear ?? ''})`
      );
    }
  }

  if (
    candidate_expectation.expected_roles.length > 0 ||
    candidate_expectation.expected_cities.length > 0
  ) {
    lines.push('');
    lines.push('Expectations:');
    if (candidate_expectation.expected_roles.length > 0)
      lines.push(`- Roles: ${candidate_expectation.expected_roles.join(', ')}`);
    if (candidate_expectation.expected_cities.length > 0)
      lines.push(`- Cities: ${candidate_expectation.expected_cities.join(', ')}`);
  }

  return lines.join('\n').trim();
}
