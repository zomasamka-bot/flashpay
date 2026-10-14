"""Isolated deterministic contract probe; no DB/Redis/network connections."""
from datetime import datetime, timezone

def current_bootstrap(marker, projections, index):
    if marker == 'done': return 'done', index
    for pid, p in projections.items():
        if pid not in index: index[pid] = p['createdAtMs']  # ZADD NX
    return 'done', index

def current_reader(marker, index, projections):
    if marker != 'done': return 503
    ordered = sorted(index, key=lambda k: (index[k], k), reverse=True)
    if len(ordered) > 2000: return 503
    prev = float('inf')
    for pid in ordered:
        p = projections.get(pid)
        if p is None or p['createdAtMs'] > prev: return 503
        prev = p['createdAtMs']
    return 200

def required_contract(durable_ids, index, projections):
    if set(durable_ids) != set(index) or set(durable_ids) != set(projections): return 'INDETERMINATE'
    if any(index[pid] != projections[pid]['createdAtMs'] for pid in durable_ids): return 'INDETERMINATE'
    return 'CONSISTENT_WITH_INPUT_SNAPSHOT_ONLY'

p={'p1': {'createdAtMs':100}, 'p2': {'createdAtMs':200}}
cases=[
 ('marker_done_missing_durable_payment','done',dict(p),{'p1':100},['p1','p2']),
 ('wrong_scores_same_order','done',dict(p),{'p1':1,'p2':2},['p1','p2']),
 ('orphan_index_member','done',dict(p),{'p1':100,'p2':200,'orphan':300},['p1','p2']),
 ('missing_projection_durable_payment','done',{'p1':p['p1']},{'p1':100},['p1','p2']),
 ('valid_input_snapshot','done',dict(p),{'p1':100,'p2':200},['p1','p2']),
]
for name,marker,projections,index,durable in cases:
    before=current_reader(marker,index,projections)
    newmarker,newindex=current_bootstrap(marker,projections,dict(index))
    after=current_reader(newmarker,newindex,projections)
    contract=required_contract(durable,newindex,projections)
    print(f'{name}: existing_reader={before}, bootstrap={newmarker}, after={after}, proposed_contract={contract}')
assert current_reader('done', {'p1':100},p)==200
assert current_reader('done', {'p1':1,'p2':2},p)==200
assert required_contract(['p1','p2'], {'p1':100},p)=='INDETERMINATE'
assert required_contract(['p1','p2'], {'p1':1,'p2':2},p)=='INDETERMINATE'
print('MODEL ASSERTIONS PASS (not original TypeScript runtime)')
