// PoC 简化方案：从 filename 推断 JD
//
// 真实 filename 模式（来自 MinIO recruit-resume-raw bucket 的实际数据）：
//   <uuid>-【职位 [_或空格] 城市 [_或空格] 薪资】候选人姓名 [_或空格] 年限.pdf
// 例:
//   222a3b35-...-【AI 产品经理（客服 _ 工作流方向）_深圳 12-13K】刘芷萱 26年应届生.pdf
//   00b2dc44-...-【算法工程师_深圳 10-15K】李刚帅 2年.pdf
//   06613150-...-【腾讯项目游戏视觉UI界面岗（需作品）_深圳_12-18K】萱萱_12年.pdf
//
// 也存在不带括号的简化命名（不支持，返回 null）：
//   014d3d0b-...-Ai软件工程师 -刘奕含.pdf

export type InferredJD = {
  jobTitle: string;
  city: string;
  salaryRange: string;
  candidateName: string;
  yearsExp: string;
  jdText: string;
};

const UUID_PREFIX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9-]{20,}-/;
const SALARY_PATTERN = /(?:^|[_\s])([\d.]+(?:-[\d.]+)?(?:[Kk万元]|千))/;

export function inferJdFromFilename(filename: string): InferredJD | null {
  // 1. 去掉可选 UUID 前缀
  let name = filename.replace(UUID_PREFIX, '');

  // 2. 去扩展名
  name = name.replace(/\.\w+$/, '');

  // 3. 找最外层 【...】
  const openIdx = name.indexOf('【');
  const closeIdx = name.lastIndexOf('】');
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return null;

  const inside = name.slice(openIdx + 1, closeIdx).trim();
  const after = name.slice(closeIdx + 1).trim();
  if (!inside || !after) return null;

  // 4. 在 inside 里找薪资（10-15K / 12万 / 8K）
  const salaryMatch = inside.match(SALARY_PATTERN);
  let jobAndCity: string;
  let salaryRange: string;
  if (salaryMatch && salaryMatch.index !== undefined) {
    salaryRange = inside.slice(salaryMatch.index).replace(/^[_\s]+/, '').trim();
    jobAndCity = inside.slice(0, salaryMatch.index).trim();
  } else {
    jobAndCity = inside;
    salaryRange = '';
  }

  // 5. jobAndCity 拆 职位 / 城市
  //    - 用 "_" 或空格分隔
  //    - 最后一段视为城市，其余拼回职位
  const parts = jobAndCity.split(/[_\s]+/).filter(Boolean);
  if (parts.length < 1) return null;
  let jobTitle: string;
  let city: string;
  if (parts.length === 1) {
    jobTitle = parts[0];
    city = '';
  } else {
    city = parts[parts.length - 1];
    jobTitle = parts.slice(0, -1).join('_');
  }
  if (!jobTitle) return null;

  // 6. after = 候选人名 + 年限
  const afterParts = after.split(/[_\s]+/).filter(Boolean);
  const candidateName = afterParts[0] ?? '';
  const yearsExp = afterParts.slice(1).join(' ');

  // 7. 合成 JD 文本
  const jdLines: string[] = [`职位 / Position: ${jobTitle}`];
  if (city) jdLines.push(`工作地点 / Location: ${city}`);
  if (salaryRange) jdLines.push(`薪资范围 / Salary Range: ${salaryRange}`);
  if (yearsExp) jdLines.push(`要求经验 / Years Required: ${yearsExp}`);
  jdLines.push('');
  jdLines.push('岗位描述 / Description:');
  jdLines.push(
    `本岗位为 ${jobTitle} 职位` +
      (city ? `，工作地点位于${city}` : '') +
      (salaryRange ? `，薪资范围 ${salaryRange}` : '') +
      '。'
  );
  if (yearsExp) jdLines.push(`需具备相关领域 ${yearsExp}工作经验。`);
  jdLines.push('');
  jdLines.push(
    '（注：本 JD 由简历 filename 推断，仅用于 PoC 演示。生产环境应通过 RAAS 提供的 jd_id 拉取完整 JD 文本。）'
  );

  return {
    jobTitle,
    city,
    salaryRange,
    candidateName,
    yearsExp,
    jdText: jdLines.join('\n'),
  };
}
