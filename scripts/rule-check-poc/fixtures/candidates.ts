// 5 个测试候选人简历 — 每个候选人是为某个具体 JD 量身定制的(strict 1:1)。
//
// 候选人技能、薪资期望都跟目标 JD 对齐,这样 prompt 里只有"目标规则"会命中,
// 不会被 10-5(硬性要求一票否决)/ 10-7(薪资)等连带触发,demo 输出更清晰。

import type { ParsedResume } from '../types';

export interface NamedCandidate {
  id: string;
  label: string;
  target_jd_id: string;       // 该候选人在 production 中应当被关联到的 JD
  expected_trigger: string;    // 期待命中的规则 / 决策
  resume: ParsedResume;
}

export const CANDIDATES: NamedCandidate[] = [
  // ═══════════════════════════════════════════════════════════════
  //  C1 — 张三 (Frontend, clean baseline)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c01-zhangsan-clean',
    label: '张三 — 5 年前端,阿里 + 字节背景,清白无红线',
    target_jd_id: 'jr-tencent-pcg-frontend',
    expected_trigger: '所有规则 PASS / NOT_APPLICABLE → KEEP',
    resume: {
      name: '张三',
      email: 'zhangsan@example.com',
      phone: '13800000000',
      location: '上海',
      birth_date: '1996-05-12',
      gender: '男',
      nationality: '中国',
      marital_status: '已婚已育',
      summary: '5 年高级前端经验,曾任阿里淘宝高级前端工程师',
      experience: [
        {
          title: '高级前端工程师', company: '阿里巴巴', location: '杭州',
          startDate: '2021-03', endDate: '2024-08',
          description: '负责淘宝交易链路前端架构;主导 webpack→vite 迁移',
          highlights: ['主导 webpack→vite 迁移', '团队规模 8 人'],
        },
        {
          title: '前端工程师', company: '字节跳动', location: '北京',
          startDate: '2018-07', endDate: '2021-02',
          description: '负责抖音电商业务前端开发',
        },
      ],
      education: [
        { degree: '本科', field: '计算机科学', institution: '浙江大学', graduationYear: '2018' },
      ],
      skills: ['React', 'TypeScript', 'Node.js', 'Webpack', 'Vite', 'Next.js', 'GraphQL'],
      languages: [{ language: '英语', proficiency: 'CET-6 580' }],
      conflict_of_interest: [],
      expected_salary_range: '35k-50k',  // ✓ 在 PCG 前端 JD 30k-50k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: null,
      former_tencent_employment: null,
      gap_periods: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════
  //  C2 — 李四 (Frontend + 1.5 月前从华为离职 → 触发 10-25)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c02-lisi-huawei-recent',
    label: '李四 — Frontend,1.5 个月前从华为离职 (3 月冷冻期内)',
    target_jd_id: 'jr-tencent-pcg-frontend',
    expected_trigger: '通用 10-25 (华为竞对未满 3 月) → REVIEW → PAUSE',
    resume: {
      name: '李四',
      email: 'lisi@example.com',
      phone: '13800000001',
      location: '深圳',
      birth_date: '1992-08-20',
      gender: '男',
      nationality: '中国',
      marital_status: '已婚已育',
      summary: '7 年前端工程师,前华为云 IAM 前端负责人',
      experience: [
        {
          title: '资深前端工程师', company: '华为', location: '深圳',
          startDate: '2019-06', endDate: '2026-03',  // 当前 2026-05,离职 1.5 月
          description: '负责华为云 IAM 控制台前端架构,React + TypeScript + 微前端',
        },
        {
          title: '前端工程师', company: '京东', location: '北京',
          startDate: '2017-07', endDate: '2019-05',
          description: '京东商城 PC + H5 端前端开发',
        },
      ],
      education: [
        { degree: '本科', field: '计算机科学', institution: '哈尔滨工业大学', graduationYear: '2017' },
      ],
      skills: ['React', 'TypeScript', 'Webpack', 'Next.js', 'Node.js'],  // ✓ 对齐 PCG JD must-have
      languages: [{ language: '英语', proficiency: 'CET-6 520' }],
      conflict_of_interest: [],
      expected_salary_range: '40k-50k',  // ✓ 在 PCG 30k-50k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: null,
      former_tencent_employment: null,
      gap_periods: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════
  //  C3 — 王五 (Java, 华腾 B8 黑名单 → 触发 10-17 DROP)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c03-wangwu-csi-blacklist',
    label: '王五 — Java 后端,前华腾员工,离职编码 B8 (有犯罪记录-YCH)',
    target_jd_id: 'jr-tencent-java',
    expected_trigger: '通用 10-17 (高风险回流人员) → FAIL → DROP',
    resume: {
      name: '王五',
      email: 'wangwu@example.com',
      phone: '13800000002',
      location: '广州',
      birth_date: '1988-11-03',
      gender: '男',
      nationality: '中国',
      marital_status: '已婚已育',
      summary: '10 年 Java 后端开发经验,擅长分布式系统',
      experience: [
        {
          title: 'Java 后端工程师', company: '某互联网公司', location: '广州',
          startDate: '2023-06', endDate: '2026-04',
          description: '负责订单交易系统重构,Spring Boot + Kafka',
        },
        {
          title: 'Java 工程师', company: '华腾', location: '广州',
          startDate: '2020-03', endDate: '2023-05',
          description: '基础平台部 Java 后端开发',
        },
      ],
      education: [
        { degree: '本科', field: '软件工程', institution: '华南理工大学', graduationYear: '2014' },
      ],
      skills: ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kafka'],  // ✓ 对齐 Java JD must-have
      languages: [{ language: '英语', proficiency: 'CET-4' }],
      conflict_of_interest: [],
      expected_salary_range: '35k-45k',  // ✓ 在 Java JD 30k-50k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: {
        company: '华腾',
        start_date: '2020-03',
        end_date: '2023-05',
        leave_code: 'B8',
        leave_reason: '有犯罪记录(YCH)',
      },
      former_tencent_employment: null,
      gap_periods: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════
  //  C4 — 赵六 (游戏后端 + 腾讯 IEG 历史 → 触发 10-3 + 10-38)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c04-zhaoliu-tencent-ieg',
    label: '赵六 — 游戏后端,前腾讯 IEG 天美工作室员工,主动离职 14 月',
    target_jd_id: 'jr-tencent-ieg-tianmei',
    expected_trigger: '腾讯 10-38 (历史从业核实) + 部门级 10-3 (IEG 活跃流程)',
    resume: {
      name: '赵六',
      email: 'zhaoliu@example.com',
      phone: '13800000003',
      location: '深圳',
      birth_date: '1990-04-15',
      gender: '男',
      nationality: '中国',
      marital_status: '已婚已育',
      summary: '6 年游戏后端开发经验,前腾讯 IEG 天美工作室资深工程师',
      experience: [
        {
          title: '游戏后端工程师', company: '某游戏公司', location: '深圳',
          startDate: '2025-03', endDate: '2026-04',
          description: '负责手游服务端架构,C++ + Lua + Redis',
        },
        {
          title: '资深游戏工程师', company: '腾讯', location: '深圳',
          startDate: '2019-08', endDate: '2025-02',
          description: '腾讯 IEG 天美工作室,负责《王者荣耀》后端架构',
        },
      ],
      education: [
        { degree: '硕士', field: '计算机科学', institution: '北京大学', graduationYear: '2019' },
      ],
      skills: ['C++', 'Lua', 'Redis', 'Protobuf', 'UnrealEngine'],  // ✓ 对齐 IEG 天美 must-have
      languages: [{ language: '英语', proficiency: 'CET-6 510' }],
      conflict_of_interest: [],
      expected_salary_range: '45k-58k',  // ✓ 在 IEG 天美 35k-60k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: null,
      former_tencent_employment: {
        company: '腾讯',
        business_group: 'IEG',
        studio: '天美',
        employment_type: '正式',
        start_date: '2019-08',
        end_date: '2025-02',
        leave_type: '主动离场',
      },
      gap_periods: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════
  //  C5 — 周七 (Data analyst + 美籍 + 28F未婚 → 触发 10-35 + 10-47)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c05-zhouqi-foreign-data',
    label: '周七 — 数据分析师,美籍华人,28 岁未婚女性',
    target_jd_id: 'jr-tencent-cdg-data',
    expected_trigger: '腾讯 10-35 (外籍通道 flag) + 10-47 (婚育风险审视) → PAUSE',
    resume: {
      name: '周七 / Zhou Qi',
      email: 'zhouqi@example.com',
      phone: '13800000004',
      location: '上海',
      birth_date: '1997-09-22',
      gender: '女',
      nationality: '美国',
      marital_status: '未婚',
      summary: '5 年数据分析经验,前 Meta 高级数据分析师',
      experience: [
        {
          title: '高级数据分析师', company: 'Meta', location: '硅谷',
          startDate: '2021-07', endDate: '2024-12',
          description: '负责 Instagram 增长数据建模,Python + SQL + Spark',
        },
        {
          title: '数据分析师', company: 'LinkedIn', location: '硅谷',
          startDate: '2019-08', endDate: '2021-06',
          description: '广告算法效果分析',
        },
      ],
      education: [
        { degree: '硕士', field: 'Statistics', institution: 'Stanford University', graduationYear: '2019' },
      ],
      skills: ['Python', 'SQL', 'Spark', 'Tableau', 'R'],  // ✓ 对齐 CDG 数据 must-have
      languages: [
        { language: '英语', proficiency: 'Native' },
        { language: '中文', proficiency: 'Native' },
      ],
      conflict_of_interest: [],
      expected_salary_range: '30k-40k',  // ✓ 在 CDG 25k-40k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: null,
      former_tencent_employment: null,
      gap_periods: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════
  //  C6 — 钱八 (Frontend + 字节正编经历 → 触发字节 10-49)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'c06-qianba-bytedance-history',
    label: '钱八 — Frontend,前字节跳动正式员工,2 年前主动离职',
    target_jd_id: 'jr-bytedance-tiktok-fe',
    expected_trigger: '字节 10-49 (字节正编员工回流标记) → REVIEW → PAUSE',
    resume: {
      name: '钱八',
      email: 'qianba@example.com',
      phone: '13800000005',
      location: '北京',
      birth_date: '1995-12-10',
      gender: '男',
      nationality: '中国',
      marital_status: '未婚',
      summary: '6 年前端,前字节跳动抖音电商前端架构师',
      experience: [
        {
          title: '高级前端工程师', company: '美团', location: '北京',
          startDate: '2024-04', endDate: '2026-04',
          description: '美团外卖商家端前端开发',
        },
        {
          title: '前端工程师 / 架构师', company: '字节跳动', location: '北京',
          startDate: '2020-07', endDate: '2024-03',
          description: '抖音电商商品详情页 React 架构',
        },
      ],
      education: [
        { degree: '本科', field: '软件工程', institution: '南京大学', graduationYear: '2020' },
      ],
      skills: ['React', 'TypeScript', 'Next.js', 'Node.js'],  // ✓ 对齐 TikTok 前端 must-have
      languages: [{ language: '英语', proficiency: 'CET-6 550' }],
      conflict_of_interest: [],
      expected_salary_range: '40k-50k',  // ✓ 在 TikTok 30k-50k 范围内
      outsourcing_acceptance: '接受',
      labor_form_preference: '正编',
      former_csi_employment: null,
      former_tencent_employment: null,
      gap_periods: [],
    },
  },
];

export function getCandidate(id: string): NamedCandidate {
  const c = CANDIDATES.find((c) => c.id === id);
  if (!c) throw new Error(`Unknown candidate id: ${id}`);
  return c;
}
