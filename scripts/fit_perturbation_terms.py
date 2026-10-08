#!/usr/bin/env python3
"""Fit the perturbation layer (report s.11).  Delta* = Delta + sum_k beta_k z_k.
Candidates = factors the three models rely on (ADR, pickup, conversion importances) + a few hand-picked ones.
Each candidate is screened for (1) outcome leakage, (2) double counting against the base equations, then fitted by ridge
and kept only if held-out error shrinks in every year-fold.
Run: python3 scripts/fit_perturbation_terms.py --calendar Nexus_Transient_Demand_v2.csv --training rfp_training_data_complete_v3_with_transient.csv
     [--importances scripts/perturbation_importances.json] [--out_json perturbation_result.json] [--out_js src/perturbationTerms.js]
Needs pandas numpy scikit-learn.  Label: SIMULATED data until refit on real closed-group actuals + PMS history."""
import argparse, json, warnings, numpy as np, pandas as pd
from sklearn.ensemble import GradientBoostingRegressor as GBR
from sklearn.linear_model import RidgeCV, Ridge
from sklearn.preprocessing import StandardScaler
warnings.filterwarnings('ignore')
ap=argparse.ArgumentParser()
ap.add_argument('--calendar',required=True); ap.add_argument('--training',required=True)
ap.add_argument('--importances',default='scripts/perturbation_importances.json')
ap.add_argument('--out_json',default='perturbation_result.json'); ap.add_argument('--out_js',default=None)
args=ap.parse_args()
CPOR=50; TOT=220; W=(.3,.4,.3)
def holidays(y):
    import datetime as dt
    h={}
    def nth(m,wd,n):
        d=dt.date(y,m,1); c=0
        while True:
            if d.weekday()==wd:
                c+=1
                if c==n: return d
            d+=dt.timedelta(1)
    def last(m,wd):
        d=dt.date(y,m+1,1)-dt.timedelta(1) if m<12 else dt.date(y,12,31)
        while d.weekday()!=wd: d-=dt.timedelta(1)
        return d
    h['newyear']=dt.date(y,1,1); h['mlk']=nth(1,0,3); h['presidents']=nth(2,0,3); h['memorial']=last(5,0)
    h['july4']=dt.date(y,7,4); h['labor']=nth(9,0,1); h['columbus']=nth(10,0,2); h['thanksgiving']=nth(11,3,4)
    h['christmas']=dt.date(y,12,25); h['xmaseve']=dt.date(y,12,24); h['nye']=dt.date(y,12,31); h['easter']=None
    return h
def easter(y):
    import datetime as dt
    a=y%19;b=y//100;c=y%100;d=b//4;e=b%4;f=(b+8)//25;g=(b-f+1)//3;h=(19*a+b-d-g+15)%30;i=c//4;k=c%4;l=(32+2*e+2*i-h-k)%7;m=(a+11*h+22*l)//451
    mo=(h+l-7*m+114)//31;da=((h+l-7*m+114)%31)+1; return dt.date(y,mo,da)
def feats(dates):
    out=[]
    for d in dates:
        d=pd.Timestamp(d); y=d.year
        hs=[v for k,v in holidays(y).items() if v]+[easter(y)]
        for yy in (y-1,y+1): hs+=[v for k,v in holidays(yy).items() if v]
        dd=[(pd.Timestamp(h)-d).days for h in hs]
        near=min(dd,key=abs)
        doy=d.dayofyear
        out.append(dict(dow=d.dayofweek,month=d.month,doy=doy,s=np.sin(2*np.pi*doy/365.25),c=np.cos(2*np.pi*doy/365.25),
            wk=d.isocalendar()[1],near=max(-7,min(7,near)),absnear=min(7,abs(near)),dom=d.day,
            wkend=int(d.dayofweek>=4 and d.dayofweek<=5)))
    return pd.DataFrame(out)

cal=pd.read_csv(args.calendar,parse_dates=['Date'])
cal=pd.DataFrame({'date':cal.Date,'adr':cal.Transient_ADR,'grp':cal.Group_Rooms_On_Books,'D':cal.Transient_Demand_Unconstrained})
Xc=feats(cal.date); yr=cal.date.dt.year.values
cal['Dh']=np.nan; cal['Ah']=np.nan
for y in (2023,2024,2025):
    tr=yr!=y; te=yr==y
    for col,out in (('D','Dh'),('adr','Ah')):
        m=GBR(n_estimators=250,max_depth=3,learning_rate=.04,subsample=.8,random_state=0,loss='absolute_error').fit(Xc[tr],cal.loc[tr,col])
        cal.loc[te,out]=m.predict(Xc[te])
err=cal.D-cal.Dh; lo,hi=np.quantile(err,.1),np.quantile(err,.9); cal=cal.set_index('date')
def disp(D,B,cap): return max(0.0,min(B+D-cap,B,D))
d=pd.read_csv(args.training,low_memory=False)
d=d[(d.is_won==1)&(d.room_block>0)&d.actual_pickup_rate.notna()&(d.quoted_adr>0)].reset_index(drop=True)
d['arr']=pd.to_datetime(d.arrival_date); rows=[]
for i,r in d.iterrows():
    B=float(r.room_block); n=int(r.nights); Q=float(r.quoted_adr); ph=float(r.segment_expected_pickup); pa=float(r.actual_pickup_rate)
    est=act=0.0; ok=True; sD=sA=sC=sE=0.0
    for k in range(n):
        dt=r.arr+pd.Timedelta(days=k)
        if dt not in cal.index: ok=False; break
        c=cal.loc[dt]; com=min(TOT,max(0.0,float(c.grp)-B)); cap=TOT-com; Dh=max(0.0,c.Dh)
        e=sum(w*disp(max(0,Dh+s),B,cap) for w,s in zip(W,(lo,0,hi)))
        est+=B*ph*Q-e*c.Ah-CPOR*B*ph; act+=B*pa*Q-disp(float(c.D),B,cap)*float(c.adr)-CPOR*B*pa
        sD+=Dh; sA+=c.Ah; sC+=com; sE+=e
    if ok: rows.append((i,est,act,sD/n,sA/n,sC/n,sE/n))
g=pd.DataFrame(rows,columns=['i','est','act','Dh','Ah','com','edisp']).set_index('i'); d=d.join(g,how='inner'); d['res']=d.act-d.est
print('groups',len(d),' mean residual %.0f sd %.0f'%(d.res.mean(),d.res.std()))
# ---- candidate list: importances of the three models + hand-picked
imp=json.load(open(args.importances)); src={}
for m in ('adr','pickup','conversion'):
    for f,_ in imp[m]: src.setdefault(f,[]).append(m)
for f in ['is_peak_season','is_shoulder_season','lead_time_days','nights','log_block','pickup_momentum','booking_pace_rooms_per_day','arrival_month_sin','arrival_month_cos']:
    src.setdefault(f,[]).append('manual')
if 'is_peak_arrival' in src:
    src.setdefault('is_peak_season',[]).extend(src.pop('is_peak_arrival')); src['is_peak_season']=sorted(set(src['is_peak_season']))
    if 'is_peak_season' not in d.columns and 'is_peak_arrival' in d.columns: d['is_peak_season']=d['is_peak_arrival']
d['log_block']=np.log1p(d.room_block); d['arrival_month_cos']=np.cos(2*np.pi*d.arr.dt.month/12)
if 'arrival_month_sin' not in d: d['arrival_month_sin']=np.sin(2*np.pi*d.arr.dt.month/12)
LEAK={ 'Is_Compression_Date':'realised sold-out flag for the stay date',
 'displacement_ema_7d':'moving average of realised displacement','segment_avg_revenue_intensity':'segment mean that includes the group\'s own outcome',
 'proposed_total_revenue':'final contract figure for won groups','on_books_occupancy_pct':'on-the-books count includes the group\'s own block'}
def leak_reason(f):
    if f.startswith('tr_'): return 'realised calendar value for the stay date'
    return LEAK.get(f)
cands=[]; skipped=[]
for f,sm in src.items():
    if f not in d.columns: skipped.append((f,'not in the training table')); continue
    cands.append(f)
for f in cands: d[f]=pd.to_numeric(d[f],errors='coerce')
elig=[f for f in cands if not leak_reason(f) and d[f].nunique()>1]
X=d[elig].astype(float); X=X.fillna(X.median()); y=d.res.values; d['y']=d.arr.dt.year
# ---- double-counting test against base-equation inputs
C=d[['Dh','Ah','com','edisp','est','segment_expected_pickup','quoted_adr','room_block','nights']].astype(float)
C=(C-C.mean())/C.std(); C1=np.column_stack([np.ones(len(d)),C.values])
def ols(A,t): b=np.linalg.lstsq(A,t,rcond=None)[0]; return b
Z=(X-X.mean())/X.std()
dc={}; rng=np.random.default_rng(0)
for f in elig:
    z=Z[f].values; bz=ols(C1,z); r2=1-((z-C1@bz)**2).sum()/((z-z.mean())**2).sum()
    A0=np.column_stack([np.ones(len(d)),z]); b_alone=ols(A0,y)[1]
    A1=np.column_stack([C1,z]); b_ctrl=ols(A1,y)[-1]
    bs=[]
    for _ in range(200):
        ix=rng.integers(0,len(d),len(d)); bs.append(ols(A1[ix],y[ix])[-1])
    lo_c,hi_c=np.quantile(bs,[.025,.975]); incl0=bool(lo_c<=0<=hi_c)
    redundant=bool(r2>=.80); absorbed=bool(abs(b_ctrl)<.5*abs(b_alone) or incl0)
    dc[f]=dict(r2_base=float(r2),beta_alone=float(b_alone),beta_ctrl=float(b_ctrl),ci_ctrl=[float(lo_c),float(hi_c)],redundant=redundant,absorbed=absorbed,double_counts=bool(redundant or absorbed))
# ---- ridge fit with year folds (on eligible, then on eligible and independent)
def run(cols,label):
    Xs=X[cols]; trm=(d.y<=2024).values; tem=~trm
    def fit(tr):
        sc=StandardScaler().fit(Xs[tr]); m=RidgeCV(alphas=np.logspace(0,4,25)).fit(sc.transform(Xs[tr]),y[tr]); return sc,m
    sc,m=fit(trm); pred=m.predict(sc.transform(Xs[tem]))
    mb=np.abs(y[tem]-y[trm].mean()).mean(); mr=np.abs(y[tem]-pred).mean(); gains=[]
    for ty in (2023,2024,2025):
        t=(d.y!=ty).values; s_,m_=fit(t); p=m_.predict(s_.transform(Xs[~t])); gains.append(np.abs(y[~t]-y[t].mean()).mean()-np.abs(y[~t]-p).mean())
    sc2=StandardScaler().fit(Xs); m2=Ridge(alpha=m.alpha_).fit(sc2.transform(Xs),y)
    boots=[]
    for _ in range(300):
        ix=rng.integers(0,len(d),len(d)); s_=StandardScaler().fit(Xs.iloc[ix]); boots.append(Ridge(alpha=m.alpha_).fit(s_.transform(Xs.iloc[ix]),y[ix]).coef_)
    boots=np.array(boots); res={}
    for j,f in enumerate(cols):
        l,h=np.quantile(boots[:,j],[.025,.975]); res[f]=dict(beta=float(m2.coef_[j]),ci=[float(l),float(h)],stable=bool(l>0 or h<0))
    print('%s: %d factors | 2025 hold-out MAE bias-only %.0f ridge %.0f | fold gains %s'%(label,len(cols),mb,mr,np.round(gains,1)))
    return dict(n_factors=len(cols),mae_bias_only=float(mb),mae_ridge=float(mr),fold_gain=[float(v) for v in gains],alpha=float(m.alpha_),coefs=res,sc=sc2,intercept=float(m2.intercept_))
A=run(elig,'A all non-leaky candidates')
indep=[f for f in elig if not dc[f]['double_counts']]
B=run(indep,'B + not double counting') if indep else None
final=B if B else A
passes=bool(final['mae_ridge']<final['mae_bias_only'] and all(g>0 for g in final['fold_gain']))
accepted=[f for f in indep if final['coefs'][f]['stable']] if (B and passes) else []
lab={'is_peak_season':'Peak-season arrival','is_peak_arrival':'Peak-season arrival','is_shoulder_season':'Shoulder-season arrival','lead_time_days':'Lead time (days)','nights':'Number of nights','log_block':'Room block size (log)','pickup_momentum':'Recent pickup momentum','booking_pace_rooms_per_day':'Booking pace (rooms/day)','arrival_month_sin':'Seasonal cycle (sin)','arrival_month_cos':'Seasonal cycle (cos)','historical_demand_this_month':'Typical demand this month','arrival_day_of_week':'Arrival day of week','arrival_day_of_year':'Arrival day of year','avg_discount_nearby_60d':'Average nearby discount (60d)','arrival_quarter_cos':'Quarter cycle (cos)','historical_demand_this_week':'Typical demand this week','days_to_next_quarter':'Days to next quarter','confident_expected_pickup':'Segment expected pickup (confident)','decision_time_days':'Decision time (days)','response_due_days':'Response due (days)','full_day_pct':'Full-day meeting share','night_variance_pct':'Night-to-night variance','forecasted_occupancy':'Forecast hotel occupancy','destinations_considered':'Destinations considered','attendees':'Attendees','room_block':'Room block','decision_days_cvent':'Decision days (Cvent)','budget_provided':'Budget provided','Is_Compression_Date':'Sold-out (compression) date','displacement_ema_7d':'Recent displacement trend','segment_avg_revenue_intensity':'Segment avg revenue intensity','proposed_total_revenue':'Proposed total revenue','on_books_occupancy_pct':'Rooms already booked on stay nights'}
table=[]
for f in cands:
    row=dict(factor=f,label=lab.get(f,f),sources=src[f]); lr=leak_reason(f)
    if lr: row.update(status='excluded: leak',reason=lr)
    elif f not in elig: row.update(status='excluded',reason='no variation')
    else:
        r=dc[f]; fa=A['coefs'][f]; row.update(betaPerSd=round(fa['beta'],1),ci95=[round(v,1) for v in fa['ci']],stableInSample=fa['stable'],
          r2Base=round(r['r2_base'],2),betaAlone=round(r['beta_alone'],1),betaControlled=round(r['beta_ctrl'],1),doubleCounts=r['double_counts'],
          mean=round(float(X[f].mean()),4),sd=round(float(X[f].std()),4))
        row['status']='accepted' if f in accepted else (('redundant' if r['redundant'] else 'absorbed') if r['double_counts'] else ('not used: fails held-out' if fa['stable'] else 'not used: unstable'))
    table.append(row)
for f,why in skipped: table.append(dict(factor=f,label=lab.get(f,f),sources=src[f],status='excluded',reason=why))
meta=dict(label='Simulated',n=int(len(d)),trained='2023-2025 won groups (simulated)',candidatesFromImportances=sorted([f for f in src if src[f]!=['manual']]),
  nCandidates=len(src),nLeak=sum(1 for t in table if t['status']=='excluded: leak'),nRedundant=sum(1 for t in table if t['status']=='redundant'),nAbsorbed=sum(1 for t in table if t['status']=='absorbed'),nDoubleCount=sum(1 for t in table if t['status'] in ('redundant','absorbed')),nFitted=len(elig),
  heldOut=dict(year=2025,mae_bias_only=final['mae_bias_only'],mae_ridge=final['mae_ridge']),foldGainMae=[round(v,1) for v in final['fold_gain']],
  allCandidatesHeldOut=dict(mae_bias_only=A['mae_bias_only'],mae_ridge=A['mae_ridge'],foldGain=[round(v,1) for v in A['fold_gain']]),
  gatePassed=passes,meanResidual=round(float(y.mean())),sdResidual=round(float(y.std())),cpor=CPOR)
acc=[dict(factor=f,label=lab.get(f,f),betaPerSd=round(final['coefs'][f]['beta'],1),mean=round(float(X[f].mean()),4),sd=round(float(X[f].std()),4)) for f in accepted]
json.dump(dict(meta=meta,candidates=table,accepted=acc),open(args.out_json,'w'),indent=1)
print('LEAK-excluded:',[t['factor'] for t in table if t['status']=='excluded: leak'])
print('DOUBLE-COUNTS:',[t['factor'] for t in table if t['status'] in ('redundant','absorbed')])
print('independent:',indep); print('held-out gate passed:',passes,'| ACCEPTED:',accepted)
if args.out_js:
    js=open(args.out_js).read() if False else None
    tmpl=open(__file__.replace('fit_perturbation_terms.py','perturbation_terms_template.js')).read() if False else None
