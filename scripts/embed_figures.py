#!/usr/bin/env python3
"""単位（空欄1つ＝アプリの1問）ごとに、その問題が実際に参照している図だけを埋め込む。

判定ロジック（設計 2026-10-11・RF指示「該当箇所のみ必要な図を採用」）
 1. 参照の抽出: 単位の body + choices + figure_ref から図参照トークンを取る。
    - 番号付き: 「図1」「図２」「図1-ア」→ {図1}（番号は全角→半角）。「図1〜図3」「図1〜3」の範囲は展開。
    - 図群: 「図群」「図群①〜③」「下記の図群」→ GROUP。選択肢が図そのものの単位も GROUP。
    - 部分図: 「平面図」→ PLAN（第36回第47問のように平面図＋小問ごとの図群がある型）。
    - 無番号: 「下図」「右図」「図中」「次の図」「図（」「図を」「図の」「写真」→ GENERIC（番号なしの単独図）。
    - 何も無ければ参照なし。
 2. 図の選択（ページの図リスト = boxes/<IMG>.json のラベル付き矩形）:
    - 図N → ラベルが「図N」「図N（…）」「図N-…」の図。
    - GROUP → ラベルに「図群」または「①」を含む図のうち、単位の小問記号（ア/イ/ウ/エ）がラベルに含まれるもの。
              記号付きの群が無ければ、群ラベルの図を全部。
    - PLAN → ラベルに「平面図」を含む図（GROUP と併用可）。
    - GENERIC → ラベルが「図」「写真」「図（…）」等の番号なし図。無ければページに図が1つだけならそれ。複数ならページの全図。
    - 参照なし → 図を付けない（has_figure=false、figure_data 削除）。
 3. 選んだ図を縦に並べて1枚に合成（幅≤800px・高さ≤1600px・JPEG q82）。
実行: python3 compose_embed.py [--dry]  … --dry は判定結果の一覧だけ出して書き込まない。
"""
import json,glob,re,base64,io,os,sys
from PIL import Image
S=os.path.dirname(os.path.abspath(__file__)); DRY='--dry' in sys.argv
man={m['image']:m for m in json.load(open(f'{S}/manifest.json'))}
Z=str.maketrans('０１２３４５６７８９','0123456789')
def norm(t): return (t or '').translate(Z).replace(' ','').replace('　','')

def refs_of(q, unit):
    """参照トークン。優先順: (1) figure_ref に具体的な図番号があればそれだけ
    (2) 本文（大問共通のリード文＝最初の「選びなさい。」までを除く）＋選択肢＋figure_ref から抽出"""
    ref=norm(q.get('figure_ref') or '')
    nums={f'図{n}' for n in re.findall(r'図(\d+)', ref)}
    if nums:
        if re.search(r'図群|[①②③]〜[②③④⑤]|三面図|図[①②③]', ref): nums.add('GROUP')
        return nums
    body=norm(q['body'])
    m=re.search(r'選びなさい。', body)
    core=body[m.end():] if m else body
    txt=core+'|'+'|'.join(norm(c) for c in q['choices'])+'|'+ref
    r=set()
    for a,b in re.findall(r'図(\d+)[〜～]図?(\d+)', txt):
        for n in range(int(a), int(b)+1): r.add(f'図{n}')
    for n in re.findall(r'図(\d+)', txt): r.add(f'図{n}')
    choices_are_figs = all(re.fullmatch(r'(図)?[①②③④⑤]', norm(c)) for c in q['choices'])
    if re.search(r'図群|図[①②③]', txt) or choices_are_figs: r.add('GROUP')
    if '平面図' in txt and ('伏図' in txt or '断面図' in txt or '図群' in txt): r.add('PLAN')
    if re.search(r'下図|右図|図中|次の図|図\(|図（|写真|図参照|（図）', txt) and not any(x.startswith('図') and x[1:].isdigit() for x in r): r.add('GENERIC')
    return r

def select(figs, r, kana, ref=''):
    lab=lambda f: norm(f['label'])
    sel=[]
    # 0) figure_ref がページの図ラベルと直接対応する場合（例: 問1-1の材料表示記号（図））はそれを採用
    R=norm(ref)
    if R:
        sel+=[f for f in figs if len(lab(f))>=4 and (lab(f) in R or R in lab(f))]
    for f in figs:
        L=lab(f)
        for n in sorted(x for x in r if re.fullmatch(r'図\d+',x)):
            if re.match(rf'^{n}(?!\d)', L): sel.append(f)
    if 'PLAN' in r: sel+=[f for f in figs if '平面図' in lab(f) and f not in sel]
    if 'GROUP' in r:
        groups=[f for f in figs if ('図群' in lab(f) or '①' in lab(f) or '群' in lab(f)) and f not in sel]
        withkana=[f for f in groups if kana and kana in lab(f)]
        if withkana: sel+=withkana
        elif not sel: sel+=groups   # 直接一致・番号一致が無い場合だけ全群にフォールバック
    if 'GENERIC' in r and not sel:
        g=[f for f in figs if re.fullmatch(r'(図|写真|図\(.*\)|図（.*）|図[^\d①②③群]*)', lab(f))]
        sel= g if g else (figs if len(figs)==1 else list(figs))
    # 順序はページ上の順（y座標）
    uniq=[]
    for f in sel:
        if f not in uniq: uniq.append(f)
    return sorted(uniq, key=lambda f: f['box'][1]) if uniq else []

def compose(im, figs, maxw=800):
    crops=[]
    for f in figs:
        x0,y0,x1,y1=f['box']; c=im.crop((x0,y0,x1,y1)).convert('RGB')
        if c.size[0]>maxw: c=c.resize((maxw,int(c.size[1]*maxw/c.size[0])), Image.LANCZOS)
        crops.append(c)
    W=max(c.size[0] for c in crops); H=sum(c.size[1] for c in crops)+16*(len(crops)-1)
    out=Image.new('RGB',(W,H),'white'); y=0
    for c in crops: out.paste(c,((W-c.size[0])//2,y)); y+=c.size[1]+16
    if out.size[1]>1600: out=out.resize((int(out.size[0]*1600/out.size[1]),1600), Image.LANCZOS)
    buf=io.BytesIO(); out.save(buf,'JPEG',quality=82,optimize=True); return buf.getvalue(), out.size

qfiles={f:json.load(open(f)) for f in glob.glob('/Users/ryo/Documents/IC-exam/data/questions/kakomon_*.json')}
byid={}
for f,d in qfiles.items():
    for q in (d if isinstance(d,list) else d['questions']): byid[q['id']]=(f,q)
KANA={'ア':'ア','イ':'イ','ウ':'ウ','エ':'エ'}
n_fig=n_none=0
for bf in sorted(glob.glob(f'{S}/boxes/*.json')):
    b=json.load(open(bf)); img=b['image']; figs=b['figures']
    if img not in man: print(f'!! {img}: マニフェスト外'); continue
    im=None
    print(f'== {img} {man[img]["source"]}  図: {[f["label"] for f in figs]}')
    for u in man[img]['units']:
        f,q=byid[u['id']]; r=refs_of(q,u); kana=u['suffix'][:1] if u['suffix'] else ''
        sel=select(figs,r,kana,q.get('figure_ref') or '') if r else []
        print(f'   {u["id"]:<22} ref={str(sorted(r)) if r else "-":<34} → {[x["label"] for x in sel] if sel else "図なし"}')
        if DRY: continue
        if sel:
            im=im or Image.open(f'{S}/{img}_rot.jpg'); data,size=compose(im,sel)
            q['figure_data']='data:image/jpeg;base64,'+base64.b64encode(data).decode(); q['has_figure']=True
            q['notes']=f'図を原本から切り出して埋め込み（{"/".join(x["label"] for x in sel)}・{size[0]}x{size[1]}・{len(data)//1024}KB）'; n_fig+=1
        else:
            q.pop('figure_data',None); q['has_figure']=False; q['notes']='図参照なし（図は付けない）'; n_none+=1
if not DRY:
    for f,d in qfiles.items(): json.dump(d,open(f,'w'),ensure_ascii=False,indent=1)
    print('embedded', n_fig, '/ no-figure', n_none)
