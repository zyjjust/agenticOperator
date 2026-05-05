// 把 RoboHire /parse-resume 的输出映射到 RAAS Prisma 期望的 4 对象嵌套
// 缺失字段一律 null/[] —— 不虚构

import type {
  CandidateExpectationNested,
  CandidateNested,
  ResumeNested,
  RuntimeNested,
} from '../inngest/client';
import type { RoboHireParsedData, RoboHireParsedExperience } from '../robohire';

const DEGREE_RANK: Record<string, number> = {
  Doctorate: 5,
  PhD: 5,
  博士: 5,
  Master: 4,
  Masters: 4,
  硕士: 4,
  Bachelor: 3,
  本科: 3,
  Associate: 2,
  专科: 2,
  大专: 2,
  Diploma: 1,
  HighSchool: 1,
  高中: 1,
};

function rankDegree(degree?: string): number {
  if (!degree) return 0;
  for (const [k, v] of Object.entries(DEGREE_RANK)) {
    if (degree.includes(k)) return v;
  }
  return 0;
}

function pickHighestDegree(edu: RoboHireParsedData['education']): string | null {
  if (!edu || edu.length === 0) return null;
  let best: { degree?: string; rank: number } = { rank: 0 };
  for (const e of edu) {
    const r = rankDegree(e.degree);
    if (r > best.rank) best = { degree: e.degree, rank: r };
  }
  return best.degree ?? edu[0]?.degree ?? null;
}

function findCurrentExperience(
  exp: RoboHireParsedExperience[] | undefined
): RoboHireParsedExperience | null {
  if (!exp || exp.length === 0) return null;
  const current = exp.find((e) => {
    const end = (e.endDate ?? '').toLowerCase();
    return (
      end === 'present' ||
      end === 'current' ||
      end.includes('至今') ||
      end.includes('现在') ||
      end === ''
    );
  });
  return current ?? exp[0];
}

function calculateWorkYears(exp: RoboHireParsedExperience[] | undefined): number | null {
  if (!exp || exp.length === 0) return null;
  let totalMonths = 0;
  const now = new Date();

  for (const e of exp) {
    const start = parseDate(e.startDate);
    if (!start) continue;
    const endRaw = (e.endDate ?? '').toLowerCase();
    const end =
      endRaw === 'present' ||
      endRaw === 'current' ||
      endRaw === '' ||
      endRaw.includes('至今') ||
      endRaw.includes('现在')
        ? now
        : parseDate(e.endDate) ?? now;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (months > 0) totalMonths += months;
  }

  return totalMonths > 0 ? Math.round((totalMonths / 12) * 10) / 10 : null;
}

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{4})[-/](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cleanMobile(s?: string): string | null {
  if (!s) return null;
  const cleaned = s.replace(/[\s\-()+]/g, '').replace(/^86/, '');
  return cleaned || null;
}

export type MappingResult = {
  candidate: CandidateNested;
  candidate_expectation: CandidateExpectationNested;
  resume: ResumeNested;
  runtime: RuntimeNested;
};

export function mapRobohireToRaas(parsed: RoboHireParsedData): MappingResult {
  const currentExp = findCurrentExperience(parsed.experience);
  const skills = parsed.skills ?? [];

  const candidate: CandidateNested = {
    name: parsed.name?.trim() || null,
    mobile: cleanMobile(parsed.phone),
    email: parsed.email?.trim() || null,
    gender: null,
    birth_date: null,
    current_location: parsed.location?.trim() || null,
    highest_acquired_degree: pickHighestDegree(parsed.education),
    work_years: calculateWorkYears(parsed.experience),
    current_company: currentExp?.company?.trim() || null,
    current_title: currentExp?.title?.trim() || null,
    skills,
  };

  const candidate_expectation: CandidateExpectationNested = {
    expected_salary_monthly_min: null,
    expected_salary_monthly_max: null,
    expected_cities: [],
    expected_industries: [],
    expected_roles: [],
    expected_work_mode: null,
  };

  const resume: ResumeNested = {
    summary: parsed.summary?.trim() || null,
    skills_extracted: skills,
    work_history:
      parsed.experience?.map((e) => ({
        title: e.title,
        company: e.company,
        startDate: e.startDate,
        endDate: e.endDate,
        description: e.description,
      })) ?? null,
    education_history: parsed.education ?? null,
    project_history: [],
  };

  const runtime: RuntimeNested = {
    current_title: candidate.current_title,
    current_company: candidate.current_company,
  };

  return { candidate, candidate_expectation, resume, runtime };
}

// 健全性检查：解析结果必须有最少能识别候选人的字段
export function hasStructuredResumePayload(parsed: MappingResult): boolean {
  const c = parsed.candidate;
  const ce = parsed.candidate_expectation;
  const r = parsed.resume;
  const rt = parsed.runtime;
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

  return Boolean(
    nonEmpty(c.name) ||
      nonEmpty(c.mobile) ||
      nonEmpty(c.email) ||
      ce.expected_roles.length > 0 ||
      nonEmpty(rt.current_title) ||
      nonEmpty(rt.current_company) ||
      r.skills_extracted.length > 0 ||
      c.skills.length > 0
  );
}
