"""
Convert MakeHuman CC0 assets into DrawDoll's compact realistic-body asset.

Usage:
    python3 -I tools/build_realistic.py <makehuman-data-dir> <output-dir>

<makehuman-data-dir> must contain base.obj, default.mhskel, default_weights.mhw,
targets/*.target (the macrodetails targets) and breast/*.target (the female
breast-size targets). Writes body.json and body.bin.

What is kept:
  - the "body" mesh (triangulated), plus the helper vertices that define joint
    centres and the eyes;
  - the macro shape targets for baby/child/young ages, with the three ethnicity
    targets averaged into one neutral target per sex and age;
  - the female breast-size targets (smaller/larger cup at average firmness) for
    child and young ages;
  - skin weights, merged from MakeHuman's 163 bones onto DrawDoll's skeleton.
Units stay in MakeHuman decimetres; the app scales the result to its own stature.
"""

import json
import os
import struct
import sys

AGES = ['baby', 'child', 'young']
SEXES = ['female', 'male']
LEVELS = ['min', 'average', 'max']
RACES = ['african', 'asian', 'caucasian']
SIDES = {'.L': '_L', '.R': '_R'}


def read_obj(path):
    verts, groups, faces = [], {}, []
    group = None
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                verts.append(tuple(float(x) for x in line.split()[1:4]))
            elif line.startswith('g '):
                group = line.split()[1]
            elif line.startswith('f '):
                idx = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
                groups.setdefault(group, []).append(idx)
    return verts, groups


def read_target(path):
    out = {}
    with open(path) as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            parts = line.split()
            out[int(parts[0])] = (float(parts[1]), float(parts[2]), float(parts[3]))
    return out


def our_bone(mh):
    """Which DrawDoll bone a MakeHuman bone's skin weight belongs to."""
    side = ''
    base = mh
    for suffix, s in SIDES.items():
        if mh.endswith(suffix):
            side, base = s, mh[: -len(suffix)]
    if base in ('root', 'spine05', 'pelvis'):
        return 'pelvis'
    if base in ('spine04', 'spine03'):
        return 'lumbar'
    if base in ('spine02', 'spine01', 'breast'):
        return 'chest'
    if base.startswith('neck'):
        return 'neck'
    if base in ('clavicle', 'shoulder01'):
        return 'clav' + side
    if base.startswith('upperarm'):
        return 'shoulder' + side
    if base.startswith('lowerarm'):
        return 'elbow' + side
    if base == 'wrist' or base.startswith('metacarpal'):
        return 'wrist' + side
    if base.startswith('finger'):
        n, k = base[len('finger'):].split('-')
        n, k = int(n), int(k)
        return (f'thumb{k - 1}' if n == 1 else f'f{n - 2}{k - 1}') + side
    if base.startswith('upperleg'):
        return 'hip' + side
    if base.startswith('lowerleg'):
        return 'knee' + side
    if base == 'foot':
        return 'ankle' + side
    if base.startswith('toe'):
        return 'toe' + side
    return 'head'  # skull, jaw, face, eyes, tongue


def joint_spec(skel):
    """DrawDoll joint name -> MakeHuman joint vertex-group names whose centre locates it."""
    b = skel['bones']
    head = lambda name: [b[name]['head']]
    tail = lambda name: [b[name]['tail']]
    spec = {
        'pelvis': head('spine05'),
        'lumbar': head('spine04'),
        'chest': head('spine02'),
        'neck': head('neck01'),
        'head': head('head'),
        'headTop': tail('head'),
    }
    for mh, s in SIDES.items():
        spec.update({
            'clav' + s: head('clavicle' + mh),
            'shoulder' + s: head('upperarm01' + mh),
            'elbow' + s: head('lowerarm01' + mh),
            'wrist' + s: head('wrist' + mh),
            'hip' + s: head('upperleg01' + mh),
            'knee' + s: head('lowerleg01' + mh),
            'ankle' + s: head('foot' + mh),
            'toe' + s: sum((head(f'toe{n}-1' + mh) for n in range(1, 6)), []),
            'toeTip' + s: tail('toe2-3' + mh),
        })
        for k in range(3):
            spec[f'thumb{k}' + s] = head(f'finger1-{k + 1}' + mh)
            for i in range(4):
                spec[f'f{i}{k}' + s] = head(f'finger{i + 2}-{k + 1}' + mh)
        spec['thumbTip' + s] = tail('finger1-3' + mh)
        spec['breast' + s] = head('breast' + mh)
        spec['nipple' + s] = tail('breast' + mh)
        for i in range(4):
            spec[f'f{i}tip' + s] = tail(f'finger{i + 2}-3' + mh)
    return spec


def main(src, dst):
    verts, groups = read_obj(os.path.join(src, 'base.obj'))
    skel = json.load(open(os.path.join(src, 'default.mhskel')))
    weights = json.load(open(os.path.join(src, 'default_weights.mhw')))['weights']

    body_faces = groups['body']
    body_verts = sorted({i for f in body_faces for i in f})
    spec = joint_spec(skel)
    joint_verts = {name: sorted({i for g in gs for i in skel['joints'][g]}) for name, gs in spec.items()}
    eye_verts = {s: sorted({i for f in groups[f'helper-{c}-eye'] for i in f}) for c, s in (('l', 'L'), ('r', 'R'))}

    keep = sorted(set(body_verts) | {i for v in joint_verts.values() for i in v} | {i for v in eye_verts.values() for i in v})
    remap = {old: new for new, old in enumerate(keep)}
    n = len(keep)

    tris = []
    for f in body_faces:
        f = [remap[i] for i in f]
        for k in range(1, len(f) - 1):
            tris += [f[0], f[k], f[k + 1]]

    # Shape targets: universal (sex x age x muscle x weight) and race-averaged (sex x age).
    targets = []
    for sex in SEXES:
        for age in AGES:
            for m in LEVELS:
                for w in LEVELS:
                    name = f'universal-{sex}-{age}-{m}muscle-{w}weight'
                    targets.append((name, read_target(os.path.join(src, 'targets', name + '.target'))))
            avg = {}
            for race in RACES:
                for i, d in read_target(os.path.join(src, 'targets', f'{race}-{sex}-{age}.target')).items():
                    a = avg.setdefault(i, [0.0, 0.0, 0.0])
                    for k in range(3):
                        a[k] += d[k] / len(RACES)
            targets.append((f'race-{sex}-{age}', {i: tuple(v) for i, v in avg.items()}))
    for age in ('child', 'young'):
        for m in LEVELS:
            for w in LEVELS:
                for cup in ('min', 'max'):
                    name = f'female-{age}-{m}muscle-{w}weight-{cup}cup-averagefirmness'
                    targets.append((f'breast-{name}', read_target(os.path.join(src, 'breast', name + '.target'))))

    max_delta = max(abs(c) for _, t in targets for d in t.values() for c in d)
    scale = max_delta / 32767

    # Skin: merge MakeHuman bone weights onto DrawDoll bones; keep the 4 strongest.
    bone_names = []
    per_vertex = [dict() for _ in range(n)]
    for mh, pairs in weights.items():
        ours = our_bone(mh)
        if ours not in bone_names:
            bone_names.append(ours)
        b = bone_names.index(ours)
        for i, wgt in pairs:
            if i in remap:
                d = per_vertex[remap[i]]
                d[b] = d.get(b, 0.0) + wgt
    skin_idx, skin_w = [], []
    for d in per_vertex:
        top = sorted(d.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in top) or 1.0
        top += [(0, 0.0)] * (4 - len(top))
        q = [round(w / total * 255) for _, w in top]
        q[0] += 255 - sum(q) if total else 0
        skin_idx += [b for b, _ in top]
        skin_w += q

    # Binary layout, every section 4-byte aligned.
    blob = bytearray()
    sections = {}

    def put(name, fmt, values):
        while len(blob) % 4:
            blob.append(0)
        sections[name] = [len(blob), len(values)]
        blob.extend(struct.pack(f'<{len(values)}{fmt}', *values))

    put('positions', 'f', [c for i in keep for c in verts[i]])
    put('indices', 'H' if n < 65536 else 'I', tris)
    put('skinIndex', 'B', skin_idx)
    put('skinWeight', 'B', skin_w)
    target_meta = []
    for name, t in targets:
        items = sorted((remap[i], d) for i, d in t.items() if i in remap and any(abs(c) > 1e-6 for c in d))
        put(name + ':idx', 'H' if n < 65536 else 'I', [i for i, _ in items])
        put(name + ':delta', 'h', [round(c / scale) for _, d in items for c in d])
        target_meta.append(name)

    meta = {
        'version': 1,
        'source': 'MakeHuman 1.1 base mesh, default skeleton weights and macro targets (CC0)',
        'units': 'decimetre',
        'vertexCount': n,
        'indexType': 'uint16' if n < 65536 else 'uint32',
        'deltaScale': scale,
        'targets': target_meta,
        'bones': bone_names,
        'joints': {k: [remap[i] for i in v] for k, v in joint_verts.items()},
        'eyes': {k: [remap[i] for i in v] for k, v in eye_verts.items()},
        'bodyVertexCount': len(body_verts),
        'sections': sections,
    }
    os.makedirs(dst, exist_ok=True)
    with open(os.path.join(dst, 'body.bin'), 'wb') as f:
        f.write(blob)
    with open(os.path.join(dst, 'body.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))
    print(f'{n} vertices, {len(tris) // 3} triangles, {len(targets)} targets, {len(bone_names)} bones, {len(blob) / 1e6:.2f} MB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
