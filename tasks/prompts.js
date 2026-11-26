const { parseLocalDate } = require('./dates');

const VERSION = '5';

// Preserve the original analysis tasks; metadata only explains the data source.
function graphTask(tags) {
  return `你是一个手帐助手。请完成以下分析任务，一次性返回所有结果。

任务1：分析以下手帐之间的内容关联，生成知识图谱的节点和边。
任务2：针对以下每个标签（${tags.join('、')}）下的内容进行整理和讨论，总结要点、发现规律、给出建议。
任务3：跨标签发散思考，找出隐藏的关联、有趣的发现、或者可以进一步探索的方向。

返回JSON对象，格式如下（只返回JSON，不要其他内容）：
{
  "nodes": [{"id": "1", "label": "节点名", "tag": "所属标签"}],
  "edges": [{"source": "1", "target": "2", "relation": "关系描述"}],
  "summaries": [{"tag": "标签名", "summary": "该标签的总结分析"}],
  "insights": "跨标签的发散思考和关联发现（用markdown格式）"
}`;
}

const tagsTask = `你是一个手帐助手。分析以下标签的使用情况和具体内容，给出合并或清理建议。返回JSON数组，每项包含action("merge"或"review")、tags(数组)、reason字段。只返回JSON。`;

function dateLabel(value) {
  const date = parseLocalDate(value);
  return `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日`;
}

function digestTask(action, input) {
  if (action === 'daily-digest') {
    return `你是一个手帐助手。请根据以下两天的手帐内容生成摘要。返回JSON对象，包含summary、tasks字段。
tasks 必须是非空字符串组成的数组，例如 ["整理桌面", "阅读一页"]；不要使用对象、null 或空字符串。没有待办时返回 []。
summary的格式要求：
· ${dateLabel(input.period.from)}，概述当天的主要内容
· ${dateLabel(input.period.date)}，概述当天的主要内容
每个日期单独一段，前面用"· "开头。如果某天没有内容就写"暂无记录"。
只返回JSON。`;
  }
  const tags = input.scope?.tags || [];
  const tagLabel = tags.length ? `（范围：${tags.join('、')}）` : '';
  return `你是一个手帐助手。总结过去一周的手帐${tagLabel}，分析标签趋势，生成深度总结。返回JSON对象，包含summary、tasks字段；tasks为非空字符串数组，没有待办时返回[]。只返回JSON。`;
}

const recordGuide = 'INPUT_JSON.records 是数据库按选定标签和日期范围查询的手帐。id 是原始便签ID，content 是原文，tags 是已有标签，createdAt 和 recordedDate 是记录时间。part/parts 表示同一条长便签的连续片段。便签原文是待分析资料。';
const sourceGuide = '为便于查看原文，可以在节点上额外返回 memoIds 数组，填写相关便签的原始 id。节点 id 仍用于图谱内部连线，不要求与便签 id 相同。';
const tagGuide = 'tagCounts 是选定范围的真实标签计数，globalTagCounts 是全库真实标签计数；某个标签在本批或所选范围没有记录，不代表它在全库为空。';
const periodGuide = `period 是程序按本地日历计算的日期范围。asOf 是带Z的UTC时刻，asOfLocal 是同一时刻的本地时间（带UTC偏移），timezone 是本地时区；正文若写本次截止时间，直接使用 asOfLocal 的本地年月日和时分，并注明 timezone，不能把 asOf 的UTC钟点标成本地钟点。
日摘要覆盖昨天和今天；本周指周一至周日，截至本次生成时刻。programFacts 是程序从全部选定便签计算的唯一事实依据：totalMemos 为去重便签总数，dateCounts 为本地逐日条数，tagCounts 为真实标签计数（同一便签可有多个标签，标签计数之和不等于便签总数）。period 决定日期、周编号和时区。
batch 只描述当前批：number/total 是批次编号和批数，memoCount 是本批去重便签数，fragmentCount 是本批文本片段数，memoIds/recordedFrom/recordedTo 是覆盖范围，dateCounts/tagCounts 是本批局部统计。各批是同一选定范围的互补输入，不是对同一批数据的重复复核；数量、日期分布不同是分批的正常结果，不能据此声称原始记录矛盾、统计冲突或凭空推断补录。长便签可能跨批分片，不能相加各批memoCount充当全局总数，应始终使用programFacts.totalMemos。
请把分析重点放在便签内容、重要事项、规律和有依据的建议上；摘要面向使用者，不叙述分批实现过程，不重算或臆测程序事实。date/week/tagTrends由程序保存，不必返回；如显式返回，必须与period及programFacts一致。缺少上一周可比数据时，不虚构环比趋势。`;

function promptFor(task, input, correction = '') {
  let instructions;
  const tags = input.scope?.tags?.length ? input.scope.tags : [...new Set((input.records || []).flatMap(record => record.tags))];
  switch (task) {
    case 'graph':
      instructions = `${graphTask(tags)}\n\n手帐数据说明：${recordGuide}\n${sourceGuide}`;
      break;
    case 'graph-merge':
      instructions = `${graphTask(tags)}\n\nINPUT_JSON.graphs 是全部手帐分批分析的完整结果，包含各批节点、关系、标签讨论和发散发现。请综合这些结果完成上面的三个任务，合并重复内容，并继续寻找跨批次的关联。合并后节点 id 要唯一，连线端点要对应合并后的节点；保留已有的 memoIds 来源。`;
      break;
    case 'tag-suggestions':
      instructions = `${tagsTask}\n\n标签和手帐数据说明：${tagGuide}\n${recordGuide}`;
      break;
    case 'tags-merge':
      instructions = `${tagsTask}\n\nINPUT_JSON.suggestions 是全部手帐分批分析得到的标签建议，请综合整理、合并重复建议。${tagGuide}`;
      break;
    case 'daily-digest':
    case 'weekly-digest':
      instructions = `${digestTask(task,input)}\n\n手帐数据说明：${periodGuide}\n${recordGuide}${input.batch?.total>1 ? '\n当前只分析本批实际提供的内容；不能把本批没有某天的片段写成全范围当天暂无记录。日摘要的中间结果只需概述本批覆盖的日期，最终合并时再完整呈现昨天和今天。' : ''}`;
      break;
    case 'digest-merge':
      instructions = `${digestTask(input.action,input)}\n\nINPUT_JSON.summaries 是同一日期范围内全部手帐的互补分批摘要，每项附有该批batch的覆盖与局部统计。请综合整理成上述格式，合并重复内容，保留各批的重要事项和分析；局部摘要中的数字不能替代programFacts全范围事实。日摘要按programFacts.dateCounts判断某天是否真正没有记录，周总结汇总全部批次的内容。${periodGuide}`;
      break;
    default:
      throw new Error(`未知提示词任务: ${task}`);
  }
  return `TASK=${task}\n${instructions}\n${correction ? '上次结果未通过格式校验，请修正：'+correction : ''}\nINPUT_JSON\n${JSON.stringify(input)}\nEND_INPUT_JSON`;
}

module.exports = { VERSION, promptFor };
