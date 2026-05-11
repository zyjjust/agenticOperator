export type Stage =
  | 'system'
  | 'requirement'
  | 'jd'
  | 'resume'
  | 'match'
  | 'interview'
  | 'eval'
  | 'package'
  | 'submit';

export type AgentKind = 'auto' | 'hitl' | 'hybrid';

export type AgentMeta = {
  short: string;
  wsId: string;
  stage: Stage;
  kind: AgentKind;
  ownerTeam: string;
  version: string;
  triggersEvents: string[];
  emitsEvents: string[];
  terminal: boolean;
};

export const AGENT_MAP: AgentMeta[] = [
  { short: 'ReqSync',          wsId: '1-1',     stage: 'system',      kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v1.4.2', triggersEvents: ['SCHEDULED_SYNC'],                                emitsEvents: ['REQUIREMENT_SYNCED', 'SYNC_FAILED_ALERT'],                                  terminal: false },
  { short: 'ManualEntry',      wsId: '1-2',     stage: 'requirement', kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['CLARIFICATION_INCOMPLETE'],                       emitsEvents: ['REQUIREMENT_LOGGED'],                                                       terminal: false },
  { short: 'ReqAnalyzer',      wsId: '2',       stage: 'requirement', kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v2.1.0', triggersEvents: ['REQUIREMENT_SYNCED', 'REQUIREMENT_LOGGED'],       emitsEvents: ['ANALYSIS_COMPLETED', 'ANALYSIS_BLOCKED'],                                   terminal: false },
  { short: 'Clarifier',        wsId: '3',       stage: 'requirement', kind: 'hybrid', ownerTeam: 'HSM·澄清',  version: 'v1.2.0', triggersEvents: ['ANALYSIS_COMPLETED'],                             emitsEvents: ['CLARIFICATION_INCOMPLETE', 'CLARIFICATION_READY'],                          terminal: false },
  { short: 'JDGenerator',      wsId: '4',       stage: 'jd',          kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v1.9.4', triggersEvents: ['CLARIFICATION_READY', 'JD_REJECTED'],             emitsEvents: ['JD_GENERATED'],                                                             terminal: false },
  { short: 'JDReviewer',       wsId: '5',       stage: 'jd',          kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['JD_GENERATED'],                                   emitsEvents: ['JD_APPROVED', 'JD_REJECTED'],                                               terminal: false },
  { short: 'TaskAssigner',     wsId: '6',       stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['JD_APPROVED'],                                    emitsEvents: ['TASK_ASSIGNED'],                                                            terminal: false },
  { short: 'Publisher',        wsId: '7-1',     stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.2.0', triggersEvents: ['TASK_ASSIGNED'],                                  emitsEvents: ['CHANNEL_PUBLISHED', 'CHANNEL_PUBLISHED_FAILED'],                            terminal: true  },
  { short: 'ManualPublish',    wsId: '7-2',     stage: 'jd',          kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['CHANNEL_PUBLISHED_FAILED'],                       emitsEvents: ['CHANNEL_PUBLISHED'],                                                        terminal: false },
  { short: 'ResumeCollector',  wsId: '8',       stage: 'resume',      kind: 'hybrid', ownerTeam: '招聘运营', version: 'v3.0.1', triggersEvents: ['CHANNEL_PUBLISHED'],                              emitsEvents: ['RESUME_DOWNLOADED'],                                                        terminal: false },
  { short: 'ResumeParser',     wsId: '9-1',     stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v2.8.0', triggersEvents: ['RESUME_DOWNLOADED'],                              emitsEvents: ['RESUME_PROCESSED', 'RESUME_PARSE_ERROR'],                                   terminal: false },
  { short: 'ResumeFixer',      wsId: '9-2',     stage: 'resume',      kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['RESUME_PARSE_ERROR'],                             emitsEvents: ['RESUME_PROCESSED'],                                                         terminal: false },
  { short: 'Matcher',          wsId: '10',      stage: 'match',       kind: 'auto',   ownerTeam: '招聘运营', version: 'v2.3.1', triggersEvents: ['RESUME_PROCESSED'],                               emitsEvents: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'], terminal: false },
  { short: 'MatchReviewer',    wsId: '10-HITL', stage: 'match',       kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['MATCH_FAILED'],                                   emitsEvents: [],                                                                           terminal: false },
  { short: 'InterviewInviter', wsId: '11-1',    stage: 'interview',   kind: 'auto',   ownerTeam: '技术招聘', version: 'v0.7.2', triggersEvents: ['MATCH_PASSED_NEED_INTERVIEW'],                    emitsEvents: ['INTERVIEW_INVITATION_SENT'],                                                terminal: true  },
  { short: 'AIInterviewer',    wsId: '11-2',    stage: 'interview',   kind: 'hybrid', ownerTeam: '技术招聘', version: 'v0.7.2', triggersEvents: ['INTERVIEW_INVITATION_SENT'],                      emitsEvents: ['AI_INTERVIEW_COMPLETED'],                                                   terminal: false },
  { short: 'Evaluator',        wsId: '12',      stage: 'eval',        kind: 'auto',   ownerTeam: '技术招聘', version: 'v1.6.0', triggersEvents: ['AI_INTERVIEW_COMPLETED'],                         emitsEvents: ['EVALUATION_PASSED', 'EVALUATION_FAILED'],                                   terminal: false },
  { short: 'ResumeRefiner',    wsId: '13',      stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.1.0', triggersEvents: ['EVALUATION_PASSED', 'MATCH_PASSED_NO_INTERVIEW'], emitsEvents: ['RESUME_OPTIMIZED'],                                                         terminal: false },
  { short: 'PackageBuilder',   wsId: '14-1',    stage: 'package',     kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.1.2', triggersEvents: ['RESUME_OPTIMIZED'],                               emitsEvents: ['PACKAGE_GENERATED', 'PACKAGE_MISSING_INFO'],                                terminal: false },
  { short: 'PackageFiller',    wsId: '14-2',    stage: 'package',     kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['PACKAGE_MISSING_INFO'],                           emitsEvents: ['PACKAGE_GENERATED'],                                                        terminal: false },
  { short: 'PackageReviewer',  wsId: '15',      stage: 'package',     kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['PACKAGE_GENERATED'],                              emitsEvents: ['PACKAGE_APPROVED'],                                                         terminal: false },
  { short: 'PortalSubmitter',  wsId: '16',      stage: 'submit',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v2.0.0', triggersEvents: ['PACKAGE_APPROVED'],                               emitsEvents: ['APPLICATION_SUBMITTED', 'SUBMISSION_FAILED'],                               terminal: true  },
  // System-level meta agent (not on workflow canvas). Registered so
  // /api/agents/Chatbot/explain + /api/agents/Chatbot/activity work and
  // chatbot audit rows surface in cross-agent UIs.
  { short: 'Chatbot',          wsId: 'system-chatbot', stage: 'system', kind: 'auto',   ownerTeam: 'AO·UI',     version: 'v1.0.0', triggersEvents: [],                                                 emitsEvents: [],                                                                           terminal: false },
];

export function byShort(s: string): AgentMeta | undefined {
  return AGENT_MAP.find((a) => a.short === s);
}

export function byWsId(id: string): AgentMeta | undefined {
  return AGENT_MAP.find((a) => a.wsId === id);
}
