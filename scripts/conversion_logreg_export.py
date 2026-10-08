import warnings,json,numpy as np,pandas as pd,pickle
warnings.filterwarnings('ignore')
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss
U='/mnt/user-data/uploads/files_kim_new_model/adr_no_outliers2/'
d=pd.read_csv(U+'rfp_training_data_complete_v3_with_transient.csv',low_memory=False)
y=d.is_won.astype(int).values
cols=['tr_transient_rooms_turned_away','tr_transient_occ_of_available','forecasted_occupancy','Is_Compression_Date','historical_demand_this_month','is_peak_arrival','is_shoulder_season','destinations_considered','attendees','room_block','nights','lead_time_days','decision_days_cvent','response_due_days','budget_provided','on_books_occupancy_pct']
X=d[cols].astype(float); med=X.median(); X=X.fillna(med); mu=X.mean(); sd=X.std(ddof=0).replace(0,1)
Z=((X-mu)/sd).values
lr=LogisticRegression(C=.3,max_iter=5000).fit(Z,y)
p=cross_val_predict(LogisticRegression(C=.3,max_iter=5000),Z,y,cv=StratifiedKFold(5,shuffle=True,random_state=0),method='predict_proba')[:,1]
m={'AUC':round(roc_auc_score(y,p),3),'logloss':round(log_loss(y,p),3),'brier':round(brier_score_loss(y,p),3),'n':len(y),'base_rate':round(y.mean(),3)}
print(m)
# calibration deciles (CV)
q=pd.qcut(p,5,duplicates='drop'); print(pd.DataFrame({'p':p,'y':y}).groupby(q).mean().round(3))
coef={c:{'w':round(float(w),5),'mu':round(float(mu[c]),5),'sd':round(float(sd[c]),5),'med':round(float(med[c]),5)} for c,w in zip(cols,lr.coef_[0])}
for c in sorted(coef,key=lambda k:-abs(coef[k]['w'])): print(f"{c:34s}{coef[c]['w']:+.3f}")
out={'b':round(float(lr.intercept_[0]),5),'link':'logistic','type':'linear','f':cols,'coef':coef,'metrics':m}
json.dump(out,open('conv2/conversion_lr.json','w'))
# reference predictions for JS parity
ref=lr.predict_proba(Z[:50])[:,1]; json.dump({'X':X.values[:50].tolist(),'p':ref.tolist()},open('conv2/parity.json','w'))
