import pickle,warnings,numpy as np,pandas as pd
warnings.filterwarnings('ignore')
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score, log_loss
from sklearn.ensemble import HistGradientBoostingClassifier
U='/mnt/user-data/uploads/files_kim_new_model/adr_no_outliers2/'
d=pd.read_csv(U+'rfp_training_data_complete_v3_with_transient.csv',low_memory=False)
o=pickle.load(open(U+'conversion_model.pkl','rb')); F=o['features']
d['length_of_stay_category_enc']=pd.Categorical(d['length_of_stay_category']).codes
y=d['is_won'].astype(int).values
skf=StratifiedKFold(5,shuffle=True,random_state=0)
def run(cols):
    p=cross_val_predict(HistGradientBoostingClassifier(max_depth=3,learning_rate=.05,max_iter=300,l2_regularization=1,random_state=0),d[cols].astype(float).values,y,cv=skf,method='predict_proba')[:,1]
    return roc_auc_score(y,p),log_loss(y,p)
groups={'ratios+proposed':['meeting_ratio','room_revenue_ratio','proposed_total_revenue'],'Meeting_Space_Ratio':['Meeting_Space_Ratio'],'Rooms_Available_Peak_Date':['Rooms_Available_Peak_Date']}
print('all20',run(F))
for g,c in groups.items(): print('drop',g,run([f for f in F if f not in c]))
print('drop ratios+RAPD',run([f for f in F if f not in groups['ratios+proposed']+groups['Rooms_Available_Peak_Date']]))
print('only ratios+proposed',run(groups['ratios+proposed']))
print('only RAPD',run(groups['Rooms_Available_Peak_Date']))
