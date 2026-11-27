#!/usr/bin/env python3
"""Render this round's checklist only; never run tests or import historical results.

Update final-acceptance-checklist.json with verified results, then rerun this file.
A pass requires a timestamp, verification mode, and evidence. Keep prior attempts.
"""
import html
import json
from collections import Counter
from pathlib import Path
from urllib.parse import quote
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'final-acceptance-checklist.json'
OUTPUT = ROOT / 'final-acceptance-checklist.html'
AGENTS = ['codex', 'trae', 'codebuddy', 'cc']
LABELS = {'codex': 'Codex', 'trae': 'Trae', 'codebuddy': 'CodeBuddy', 'cc': 'CC'}
STATUSES = {
    'pending': '☐ 待测', 'running': '◉ 测试中', 'passed': '☑ 通过',
    'failed': '✕ 失败', 'blocked': '⏸ 受阻', 'not_applicable': '— 不适用',
}
esc = lambda value: html.escape(str(value), quote=True)
MODES={'real':'真实 CLI 与模型','simulation':'模拟 CLI','controlled':'受控模拟与故障注入','sqlite-real':'隔离真实 SQLite','shared-baseline':'通用基线共享证据','environment':'环境预检','ui-real':'真实界面'}


def planned(row, agent):
    method = row['method']
    if method == 'live':
        return '模拟 CLI' if agent == 'cc' else '真实 CLI 与模型'
    return {'controlled': '可控模拟与故障注入', 'sqlite': '隔离真实 SQLite',
            'common': '通用功能实际操作', 'live-ui': '界面与模拟 CLI' if agent == 'cc' else '界面与真实 CLI'}[method]


def validate(data):
    assert data['schemaVersion'] == 1
    assert [a['id'] for a in data['agents']] == AGENTS
    ids = set()
    for row in data['cases']:
        assert row['id'] not in ids, f"Duplicate case {row['id']}"
        ids.add(row['id'])
        assert set(row['results']) == set(AGENTS), row['id']
        for agent, result in row['results'].items():
            assert result['status'] in STATUSES, (row['id'], agent)
            assert isinstance(result['evidence'], list)
            assert isinstance(result['attempts'], list)
            if result['status'] == 'passed':
                assert result['testedAt'] and result['verificationMode'] and result['evidence'], f"Pass needs evidence: {row['id']} {agent}"
                if row['method'] in ['live', 'live-ui']:
                    expected = 'simulation' if agent == 'cc' else 'real'
                    assert result['verificationMode'] == expected, f"Wrong model mode: {row['id']} {agent}"
            if result['status'] in ['blocked', 'failed', 'not_applicable']:
                assert result['detail'], f"Reason required: {row['id']} {agent}"


def cell(row, agent):
    result = row['results'][agent]
    status = result['status']
    label = '☑ 模拟通过' if status == 'passed' and result['verificationMode'] == 'simulation' else STATUSES[status]
    evidence = ''
    for ref in result['evidence']:
        file=ref.split('#',1)[0]
        if file.startswith('test/'):
            file=file[5:]
        candidate=ROOT/file
        if candidate.is_file():
            href=quote(str(candidate.relative_to(ROOT)),safe='/')
            evidence+=f'<li><a href="{esc(href)}">{esc(ref)}</a></li>'
        else:
            evidence+=f'<li><code>{esc(ref)}</code></li>'
    attempts = ''
    if result['attempts']:
        attempts = '<p>历次执行与复验</p><pre>' + esc(json.dumps(result['attempts'], ensure_ascii=False, indent=2)) + '</pre>'
    detail = result['detail'] or '尚未执行。本轮通过后才会打勾。'
    body = f'<p>{esc(detail)}</p><p>计划方式：{esc(planned(row, agent))}</p>'
    if result['testedAt']:
        when=datetime.fromisoformat(result['testedAt'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
        body += f'<p>验证时间：{esc(when)}（上海）<br>实际方式：{esc(MODES.get(result["verificationMode"],result["verificationMode"]))}</p>'
    if evidence:
        body += '<p>证据</p><ul>' + evidence + '</ul>'
    return f'<td><details class="result {status}"><summary>{label}</summary><div class="result-detail">{body}{attempts}</div></details></td>'


def render(data):
    rows = data['cases']
    categories = list(dict.fromkeys(row['category'] for row in rows))
    options = ''.join(f'<option value="{esc(c)}">{esc(c)}</option>' for c in categories)
    cards = []
    for agent in AGENTS:
        stats = Counter(row['results'][agent]['status'] for row in rows)
        applicable = len(rows) - stats['not_applicable']
        maintained=sum(bool(row.get('scopeDecision')) and row['results'][agent]['status']=='failed' for row in rows)
        mode = '模拟 CLI · 数据库真实' if agent == 'cc' else '真实 CLI · 数据库真实'
        note=f'（其中 {maintained} 项本轮维持现状）' if maintained else ''
        cards.append(f'<article class="card"><span>{LABELS[agent]}</span><strong>{stats["passed"]}<small> / {applicable} 项通过</small></strong><p>{esc(mode)}</p><p>待测 {stats["pending"]} · 失败 {stats["failed"]}{note} · 受阻 {stats["blocked"]}</p></article>')
    table = []
    for row in rows:
        states = {agent: row['results'][agent]['status'] for agent in AGENTS}
        search = ' '.join([row['id'], row['category'], row['name'], row['acceptance']] + [r['detail'] for r in row['results'].values()])
        label = f'<span class="meta">{esc(row["id"])} · {esc(row["category"])}</span><span class="case-name">{esc(row["name"])}</span><details class="criteria"><summary>通过标准</summary><p>{esc(row["acceptance"])}</p></details>'
        if row.get('scopeDecision'):
            label+=f'<p class="meta">{esc(row["scopeDecision"])}</p>'
        table.append(f'<tr id="case-{esc(row["id"])}" data-category="{esc(row["category"])}" data-search="{esc(search.lower())}" data-states="{esc(json.dumps(states))}"><th scope="row">{label}</th>' + ''.join(cell(row, agent) for agent in AGENTS) + '</tr>')
    failed=[row for row in rows if any(result['status']=='failed' for result in row['results'].values())]
    maintained=[row for row in failed if row.get('scopeDecision')]
    title=f'当前修复范围内失败 {len(failed)-len(maintained)} 项'
    if maintained:
        title+=f'，另有 {len(maintained)} 项按确认维持现状'
    findings='<details class="notice"><summary><b>'+title+'，点击查看</b></summary><ul>'
    for row in failed:
        names='、'.join(LABELS[agent] for agent in AGENTS if row['results'][agent]['status']=='failed')
        findings+=f'<li><a href="#case-{esc(row["id"])}">{esc(row["id"])} {esc(row["name"])}</a> · {esc(names)}</li>'
    findings+='</ul></details>'
    fix_summary=''
    latest=data.get('latestFixSummary')
    if latest:
        href=quote(latest['evidence'],safe='/')
        fix_summary=f'<div class="notice"><b>修复复验：</b>{len(latest["fixedCases"])} 项约定修改已通过；自动化 {latest["automatedPassed"]}/{latest["automatedTests"]}，通用界面 {latest["commonUiPassed"]}/40，像素猫 {latest["catUiPassed"]}/14。卡池固定30张与现有校验按确认维持，旧失败和各次复验保留。<a href="{esc(href)}">查看修复证据汇总</a></div>'
    remaining=sum(result['status'] in ['pending','running'] for row in rows for result in row['results'].values())
    document = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆手帐 最终测试勾选表</title><style>
:root{color-scheme:light;--ink:#252e3b;--muted:#687486;--line:#dfe5ed;--bg:#f5f7fb;--blue:#345fe3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
main{max-width:1600px;margin:auto;padding:36px 28px 64px}h1{margin:0 0 8px;font-size:28px}p{margin:6px 0}a{color:var(--blue)}.intro{color:var(--muted);max-width:1100px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0 18px}.card{background:white;border:1px solid var(--line);border-radius:12px;padding:17px 20px}.card>span{font-weight:700;font-size:16px}.card strong{display:block;font-size:28px;margin:6px 0}.card small{font-weight:400;font-size:13px;color:var(--muted)}.card p{font-size:12px;color:var(--muted)}.notice{border:1px solid #f0d49a;border-radius:10px;background:#fff9eb;padding:12px 16px;margin-bottom:16px}.notice b{color:#885b0e}.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);margin:12px 0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:14px;background:white;border:1px solid var(--line);border-radius:10px;margin-bottom:12px}label{display:flex;align-items:center;gap:6px;color:var(--muted)}input,select,button{border:1px solid #ccd5e1;border-radius:6px;padding:8px;font:inherit;background:white;color:var(--ink)}input{width:260px}button{cursor:pointer}.count{margin-left:auto;color:var(--muted)}.table-wrap{overflow:auto;max-height:72vh;border:1px solid var(--line);border-radius:10px;background:white}table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;min-width:1000px}col:first-child{width:44%}col{width:14%}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}thead th{background:#edf1f8;position:sticky;top:0;z-index:4;font-size:15px}thead th small{display:block;color:var(--muted);font-size:11px;font-weight:400}tbody th{position:sticky;left:0;background:white;z-index:1;font-weight:400}tbody tr:hover th,tbody tr:hover td{background:#fafcff}.meta{display:block;font-size:11px;color:var(--muted)}.case-name{display:block;font-weight:600;margin:3px 0}.criteria{font-size:12px;color:var(--muted)}summary{cursor:pointer}.criteria summary{display:inline-block}.criteria p{font-size:13px;color:var(--ink);font-weight:400}.result summary{display:block;white-space:nowrap;font-weight:600;padding:3px 0}.pending{color:#637187}.running{color:#2851ce}.passed{color:#157347}.failed{color:#b42318}.blocked{color:#986710}.not_applicable{color:#8993a1}.result-detail{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.result-detail p{margin:8px 0}.result-detail ul{padding-left:16px}.result-detail pre{white-space:pre-wrap;max-height:220px;overflow:auto;font-size:11px}.empty{text-align:center;padding:32px;color:var(--muted)}footer{color:var(--muted);font-size:12px;margin-top:16px}button:hover{background:#f0f4ff}
@media(max-width:750px){main{padding:20px 12px}.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:22px}.count{margin-left:0}.toolbar label{width:100%}input{flex:1;min-width:0}.table-wrap{max-height:75vh}}
@media print{body{background:white}main{padding:0}.toolbar,.criteria summary{display:none}.table-wrap{max-height:none;overflow:visible;border:none}table{min-width:0}thead th,tbody th{position:static}th,td{padding:7px;font-size:10px}.cards{margin:12px 0}.notice{font-size:11px}.criteria p{font-size:10px}}
</style></head><body><main>
<h1>记忆手帐 最终测试勾选表</h1>
<p class="intro">本轮日期：__DATE__。__TOTAL__ 个测试项，每项右侧分别记录四个助手。通过后打勾，失败、受阻、待测分别保留。只有带验证时间、执行方式和证据的结果才能记为通过。</p>
<p class="intro">数据库使用隔离目录中的真实 SQLite，数据为虚构测试数据。通用功能与数据库项可明确引用共享基线证据；AI 功能必须分别验证。受控故障与协议模拟在单元格详情中标明，不替代真实模型验收。</p>
<div class="cards">__CARDS__</div>
__FIX_SUMMARY__
<div class="notice"><b>Trae 当前入口关闭。</b>真实功能按各项状态记录；本轮受阻原因及登录预检见单元格证据。Trae 列通过的通用基线、兼容回退及底层 ACP 受控验证，不能视为其真实模型通过。CC 仅模拟 AI 调用，真实内容质量项不适用。</div>
__FINDINGS__
<p class="intro">当前待执行或执行中的单元格：__REMAINING__。受阻与不适用分别记录，点击状态可查看本轮证据。</p>
<div class="legend"><span>☐ 待测</span><span>◉ 测试中</span><span>☑ 通过 / 模拟通过</span><span>✕ 失败</span><span>⏸ 受阻</span><span>— 不适用</span></div>
<div class="toolbar"><label>搜索 <input id="search" type="search" placeholder="测试项、编号、通过标准或备注"></label><label>模块 <select id="category"><option value="">全部模块</option>__OPTIONS__</select></label><label>助手 <select id="agent"><option value="">全部助手</option><option value="codex">Codex</option><option value="trae">Trae</option><option value="codebuddy">CodeBuddy</option><option value="cc">CC</option></select></label><label>状态 <select id="status"><option value="">全部状态</option><option value="pending">待测</option><option value="running">测试中</option><option value="passed">通过</option><option value="failed">失败</option><option value="blocked">受阻</option><option value="not_applicable">不适用</option></select></label><button id="reset" type="button">清除筛选</button><span id="count" class="count" aria-live="polite"></span></div>
<div class="table-wrap"><table><colgroup><col><col><col><col><col></colgroup><thead><tr><th scope="col">待测试事项<small>点击展开通过标准</small></th><th scope="col">Codex<small>AI 正常链路真实调用</small></th><th scope="col">Trae<small>真实调用待入口与权限具备</small></th><th scope="col">CodeBuddy<small>AI 正常链路真实调用</small></th><th scope="col">CC<small>AI 调用使用模拟</small></th></tr></thead><tbody id="rows">__ROWS__</tbody></table><p id="empty" class="empty" hidden>没有符合筛选条件的测试项。</p></div>
<footer>点击状态可查看执行方式、备注、证据及复验记录。结果源：<a href="final-acceptance-checklist.json">本轮测试记录 JSON</a>。每项执行并记录证据后更新勾选；历史验收结果单独保留。更新命令：<code>python3 test/render-final-acceptance-report.py</code>，重新打开或刷新此文件即可查看。</footer>
</main><script>
const rows=[...document.querySelectorAll('#rows tr')],search=document.getElementById('search'),category=document.getElementById('category'),agent=document.getElementById('agent'),status=document.getElementById('status');
function filter(){let visible=0;const query=search.value.trim().toLocaleLowerCase();for(const row of rows){const states=JSON.parse(row.dataset.states);const values=agent.value?[states[agent.value]]:Object.values(states);const show=(!query||row.dataset.search.includes(query))&&(!category.value||row.dataset.category===category.value)&&(!status.value||values.includes(status.value));row.hidden=!show;if(show)visible++;}document.getElementById('count').textContent=`显示 ${visible} / ${rows.length} 项`;document.getElementById('empty').hidden=visible!==0;}
search.addEventListener('input',filter);for(const select of [category,agent,status])select.addEventListener('change',filter);document.getElementById('reset').addEventListener('click',()=>{for(const input of [search,category,agent,status])input.value='';filter();});filter();
</script></body></html>'''
    for key, value in {'DATE': esc(data['runDate']), 'TOTAL': str(len(rows)), 'CARDS': ''.join(cards), 'OPTIONS': options, 'ROWS': ''.join(table), 'FINDINGS':findings,'REMAINING':str(remaining),'FIX_SUMMARY':fix_summary}.items():
        document = document.replace('__' + key + '__', value)
    return document


if __name__ == '__main__':
    data = json.loads(SOURCE.read_text(encoding='utf-8'))
    validate(data)
    OUTPUT.write_text(render(data), encoding='utf-8')
    print(f'Rendered {len(data["cases"])} cases, four agent columns: {OUTPUT}')
