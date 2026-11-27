#!/usr/bin/env python3
"""Import this round's explicit evidence into the four-agent checklist."""
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parent
RUN=ROOT/'final-acceptance-evidence/2026-11-25-run-01'
FIX=ROOT/'final-acceptance-evidence/2026-11-25-fix-01'
SOURCE=ROOT/'final-acceptance-checklist.json'
data=json.loads(SOURCE.read_text())
cases={row['id']:row for row in data['cases']}
agents=['codex','trae','codebuddy','cc']


def relative(path):
    return str(path.relative_to(ROOT))


def update(id, agent, status, detail, evidence, when, mode):
    if id not in cases or agent not in cases[id]['applicableAgents']:
        return
    row=cases[id]
    if status=='passed' and row['method'] in ['live','live-ui']:
        if mode != ('simulation' if agent=='cc' else 'real'):
            return
    old=row['results'][agent]
    if status=='pending' and old['status'] in ['passed','failed','blocked']:
        return
    if old['status']!='pending' and status!='pending' and old.get('testedAt') and when:
        old_time=datetime.fromisoformat(old['testedAt'].replace('Z','+00:00'))
        new_time=datetime.fromisoformat(when.replace('Z','+00:00'))
        if new_time < old_time:
            return
    value=dict(status=status,detail=detail,testedAt=when,verificationMode=mode,evidence=evidence)
    if all(old.get(key)==value[key] for key in value):
        return
    attempts=list(old['attempts'])
    if old['status'] in ['passed','failed','blocked'] and old.get('testedAt'):
        previous={key:old.get(key) for key in value}
        if previous not in attempts:
            attempts.append(previous)
    value['attempts']=attempts
    row['results'][agent]=value


api_map={
    'graph_full':['AI07','AI22'], 'graph_scope':['AI08'],
    'tag_suggestions':['AI06','AI23'], 'daily_digest':['AI09'],
    'weekly_digest':['AI10'], 'daily_scheduled':['AI11'],
    'weekly_scheduled':['AI12'], 'wish_purpose':['AI14'], 'wish_effort':['AI15'],
    'wish_pool':['AI16','AI17'], 'ai_history_delete':['AI20'],
}
for agent,file in [('codex','codex.json'),('codebuddy','codebuddy.json'),('cc','cc-simulation.json')]:
    path=RUN/agent/file
    if not path.exists():
        continue
    report=json.loads(path.read_text())
    mode='simulation' if agent=='cc' else 'real'
    for result in report.get('cases',[]):
        ids=api_map.get(result['id'],[])
        when=result.get('finishedAt',result.get('startedAt',report['startedAt']))
        for id in ids:
            detail=(result.get('detail') or result['name'])+'；'+('模拟 CLI。' if agent=='cc' else '本轮真实 CLI。')
            update(id,agent,result['status'],detail,[relative(path)+'#'+result['id']],when,mode)
        if result['id']=='graph_full' and result['status']=='passed':
            update('AI01',agent,'passed','助手设置、运行状态及实际完成任务的助手一致。',[relative(path)+'#startup',relative(path)+'#graph_full'],when,mode)

ui_map={
    'tag-stream-ui':['AI27','AI28','AI31','DUI03'],
    'daily-digest-ui':['DUI01'], 'graph-ui':['GUI01'],
    'weekly-tag-range-ui':['DUI02'],
}
for agent in ['codex','codebuddy']:
    path=RUN/agent/'ui/result.json'
    if path.exists():
        report=json.loads(path.read_text())
        for result in report.get('checks',[]):
            for id in ui_map.get(result['id'],[]):
                update(id,agent,result['status'],result.get('label',result['id'])+'；实际界面、真实 CLI，快照轮询禁用以验证真实增量。',[relative(path)+'#'+result['id']],result.get('finishedAt',report.get('finishedAt',report['startedAt'])),'real')
    path=RUN/agent/'features-ui/features-ui.json'
    if path.exists():
        report=json.loads(path.read_text())
        records={id:row for row in report['checks'] for id in row['ids']}
        for id in ['WUI01','ZUI03']:
            result=records.get(id)
            if result:
                update(id,agent,result['status'],result.get('error') or result['name'],[relative(path)+'#'+id],result.get('finishedAt',result['startedAt']),'real')
        for id, required in [('WUI02',['WUI02','WUI-GENERATE']),('ZUI01',['ZUI01','ZUI03'])]:
            results=[records.get(key) for key in required]
            if all(results) and all(row['status']=='passed' for row in results):
                update(id,agent,'passed','真实界面、真实模型；所需操作全部完成，见各阶段证据。',[relative(path)+'#'+key for key in required],results[-1].get('finishedAt',results[-1]['startedAt']),'real')

# Each worker writes only its own summary; this importer owns the matrix.
reports=[]
for name in ['summary-db.json','summary-ui.json','summary-codebuddy.json','summary-extra.json','summary-agent-controls.json','summary-release.json','summary-layout.json','summary-notification.json','summary-root.json']:
    reports.extend((name,path) for path in sorted(RUN.rglob(name)))
for subpath in ['db/summary-db.json','launcher/summary-launcher.json','ui/summary-frontend.json','root/summary-root.json']:
    path=FIX/subpath
    if path.exists():
        reports.append((path.name,path))
for name,path in reports:
    report=json.loads(path.read_text())
    entries=report.get('cases',[])
    if name=='summary-codebuddy.json':
        entries=report.get('matrixPassed',[])+report.get('matrixFailed',[])
        for result in entries:
            result['agents']=['codebuddy']
            result['testedAt']=result.get('testedAt',report['testedAt'])
            result['verificationMode']='real'
            result['evidence']=[relative(path.parent/ref.split('#')[0])+('#'+ref.split('#',1)[1] if '#' in ref else '') for ref in result['evidence']]
    for result in entries:
        for agent in result.get('agents',agents):
            references=[]
            for ref in result.get('evidence',[relative(path)]):
                if ref.startswith('test/'):
                    ref=ref[5:]
                references.append(ref)
            timestamp=result.get('testedAt') or report.get('finishedAt') or report.get('testedAt') or datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).isoformat()
            update(result['id'],agent,result['status'],result.get('detail') or '本轮该项断言通过，详见所列证据。',references,timestamp,result['verificationMode'])

SOURCE.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
for agent in agents:
    counts={status:sum(row['results'][agent]['status']==status for row in data['cases']) for status in ['passed','failed','blocked','running','pending','not_applicable']}
    print(agent,counts)
