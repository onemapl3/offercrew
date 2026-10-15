// 筛选规则给人的结论：判断摘要与工作台共用，避免摘要漏掉硬闸或显示内部原因码。
import { QUALITY_LABEL } from './quality.mjs';
export const PREFILTER_WORD = {
  company_excluded_by_user: '你排除了这家公司', non_software_role: '不是软件岗', seniority_out_of_range: '级别偏高（资深 / 管理岗）', outside_target_specialty: '方向不对',
  excluded_role: '你不做的岗位类型', non_target_role: '不是目标岗位', china_remote_unverified: '远程岗位没确认能在国内做', not_a_job_post: '不是招聘帖',
  human_not_direct_hiring: '发帖人不是直招', outside_target_location: '城市不对', cohort_mismatch: '校招届别不对', posting_closed: '岗位已关闭', outside_sprint_city: '冲刺期城市不符', ...QUALITY_LABEL,
};
