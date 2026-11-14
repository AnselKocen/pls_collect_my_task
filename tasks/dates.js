function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function parseLocalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期需要 YYYY-MM-DD 格式');
  const [year,month,day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year,month-1,day); date.setHours(0,0,0,0);
  if (localDate(date) !== value) throw new Error('日期不存在');
  return date;
}

function addDays(date, count) {
  const result = new Date(date); result.setDate(result.getDate()+count); return result;
}

function isoWeek(date) {
  // Calendar components, not elapsed milliseconds across daylight-saving boundaries.
  const thursday = new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate()+4-(thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const first = new Date(Date.UTC(year,0,1));
  return `${year}-W${String(Math.ceil(((thursday-first)/86400000+1)/7)).padStart(2,'0')}`;
}

function periodFor(action, now = new Date()) {
  const start = parseLocalDate(localDate(now));
  if (action === 'weekly-digest') start.setDate(start.getDate()-((start.getDay()+6)%7));
  else if (action === 'daily-digest') start.setDate(start.getDate()-1);
  const end = addDays(start,action === 'weekly-digest' ? 7 : 2);
  const last = addDays(end,-1);
  return {
    start:start.toISOString(), end:end.toISOString(), asOf:now.toISOString(),
    date:localDate(now), from:localDate(start), to:localDate(last),
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(action === 'weekly-digest' ? {week:isoWeek(start)} : {})
  };
}

function rangeFor({ from, to } = {}) {
  const start = from ? parseLocalDate(from) : null;
  const last = to ? parseLocalDate(to) : null;
  if (start && last && start > last) throw new Error('开始日期不能晚于结束日期');
  return { ...(start ? {start:start.toISOString()} : {}), ...(last ? {end:addDays(last,1).toISOString()} : {}) };
}

module.exports = { localDate, parseLocalDate, addDays, isoWeek, periodFor, rangeFor };
