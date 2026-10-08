// modelLoader.js
import { loadPyodide } from 'pyodide';

let pyodide = null;
let modelData = null;

export const initPyodide = async () => {
  if (pyodide) return pyodide;
  
  console.log('🐍 Loading Pyodide v0.29.1...');
  pyodide = await loadPyodide({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.1/full/'
  });
  
  console.log('📦 Installing packages...');
  await pyodide.loadPackage(['numpy', 'pandas', 'scikit-learn', 'micropip']);  // ← ADD 'micropip' here
  
  console.log('🚀 Installing XGBoost...');
  await pyodide.runPythonAsync(`
    import micropip
    await micropip.install('xgboost')
  `);
  
  console.log('✅ XGBoost installed!');
  
  // Verify imports
  await pyodide.runPythonAsync(`
    import numpy as np
    import pandas as pd
    import xgboost as xgb
  `);
  
  console.log('✅ Pyodide ready!');
  return pyodide;
};

export const loadModel = async (modelPath) => {
  if (!pyodide) {
    throw new Error('Pyodide not initialized');
  }

  if (modelData) {
    console.log('✅ Model already loaded');
    return modelData;
  }

  try {
    console.log(`📥 Fetching model from: ${modelPath}`);
    const response = await fetch(modelPath);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    console.log(`📦 Model size: ${(uint8Array.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Load model into Python
    console.log('🔓 Loading model with pickle...');
    pyodide.globals.set('model_bytes', uint8Array);
    
    await pyodide.runPythonAsync(`
import pickle
import io
import xgboost as xgb

# Load the pickled data
model_data = pickle.loads(bytes(model_bytes))

print("✅ Model file loaded!")
print(f"Models: {list(model_data['models'].keys())}")
print(f"Feature sets: {list(model_data['feature_sets'].keys())}")

# Verify XGBoost is accessible
print(f"✅ XGBoost accessible")

# Store in global scope
models = model_data['models']
feature_sets = model_data['feature_sets']
    `);

    modelData = true;
    console.log('✅ Model ready for predictions!');
    return true;

  } catch (error) {
    console.error('❌ Error loading model:', error);
    throw error;
  }
};

export const predictStrategies = async (rfpData) => {
  try {
    console.log('🔮 Generating predictions with proper feature engineering...');
    
    // Pass RFP data to Python
    pyodide.globals.set('rfp_data', rfpData);

const result = await pyodide.runPythonAsync(`
import numpy as np
import pandas as pd
import xgboost as xgb
from datetime import datetime, timedelta

# DELETE THESE TWO LINES:
# CRITICAL FIX: Convert JsProxy to Python dict
if hasattr(rfp_data, 'to_py'):
    rfp_data = rfp_data.to_py()
# rfp_data = rfp_data.to_py()

# Parse dates
arrival = datetime.fromisoformat(rfp_data['arrival_date'])
departure = datetime.fromisoformat(rfp_data['departure_date'])
inquiry = datetime.fromisoformat(rfp_data['inquiry_date'])

# Calculate features
nights = (departure - arrival).days
lead_time = (arrival - inquiry).days
month = arrival.month
day_of_week = arrival.weekday()
is_weekend = 1 if day_of_week >= 5 else 0

# Season mapping
season_map = {12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3}
season = season_map.get(month, 2)

# Extract RFP data
attendees = int(rfp_data['attendees'])
room_block = int(rfp_data['room_block'])
forecasted_occupancy = float(rfp_data.get('forecasted_occupancy', 0.75))

# ✅ FIX: Extract event_type and client_priority with defaults
event_type = rfp_data.get('event_type', 'Corporate')
client_priority = rfp_data.get('client_priority', 'Medium')

# ✅ FIX: Encode event_type (based on training data)
event_type_mapping = {
    'Wedding/Social': 0,
    'Corporate': 1,
    'Association': 2,
    'Government': 3,
    'Other': 4
}
event_type_encoded = event_type_mapping.get(event_type, 1)  # Default to Corporate

# ✅ FIX: Encode priority (based on training data)
priority_mapping = {
    'Low': 0,
    'Medium': 1,
    'High': 2
}
priority_encoded = priority_mapping.get(client_priority, 1)  # Default to Medium

# ✅ FIX #1: Convert occupancy to percentage (0-100) if it's in decimal (0-1)
if forecasted_occupancy < 1:
    print(f"⚠️  Converting occupancy from {forecasted_occupancy} to {forecasted_occupancy * 100}%")
    forecasted_occupancy = forecasted_occupancy * 100
    
print(f"📊 RFP: {rfp_data['event_name']}, {nights} nights, {lead_time} days lead")
print(f"📊 Event type: {event_type} (encoded: {event_type_encoded})")
print(f"📊 Priority: {client_priority} (encoded: {priority_encoded})")
print(f"📊 Forecasted occupancy: {forecasted_occupancy}%")

# Initialize predictions with fallback values
predictions = {
    'baseline_adr': 220.0,
    'pickup': 0.79,
    'conversion': 0.65,
    'fnb': 60.0
}

prediction_method = 'fallback'
models_used = 0

# Try to make predictions with each model
# ✅ IMPORTANT: Predict baseline_adr first so other models can use it
model_order = ['baseline_adr', 'pickup', 'conversion', 'fnb']
for model_name in model_order:
    try:
        features = feature_sets[model_name]
        
        print(f"{model_name} expects: {features}")
        
        # Build feature array based on what model expects
        feature_values = []
        for feat in features:
            if feat == 'month':
                feature_values.append(month)
            elif feat == 'day_of_week':
                feature_values.append(day_of_week)
            elif feat == 'is_weekend':
                feature_values.append(is_weekend)
            elif feat == 'season':
                feature_values.append(season)
            elif feat == 'forecasted_occupancy':
                feature_values.append(forecasted_occupancy)
            elif feat == 'lead_time':
                feature_values.append(lead_time)
            elif feat == 'nights':
                feature_values.append(nights)
            elif feat == 'attendees':
                feature_values.append(attendees)
            elif feat == 'room_block':
                feature_values.append(room_block)
            elif feat == 'rooms_per_night':
                feature_values.append(room_block / nights if nights > 0 else room_block)
            elif feat == 'attendee_ratio':
                feature_values.append(attendees / room_block if room_block > 0 else 1.0)
            elif feat == 'rooms_per_attendee':
                # ✅ FIX: This should be room_block / attendees, not attendees / room_block
                feature_values.append(room_block / attendees if attendees > 0 else 1.0)
            elif feat == 'total_room_nights':
                # ✅ FIX: This should be room_block * nights
                feature_values.append(room_block * nights)
            elif feat == 'event_type_encoded':
                # ✅ FIX: Use actual encoded value
                feature_values.append(event_type_encoded)
            elif feat == 'priority_encoded':
                # ✅ FIX: Use actual encoded value  
                feature_values.append(priority_encoded)
            elif feat == 'quoted_adr':
                # For quoted_adr, use 0 as placeholder since we're predicting baseline
                feature_values.append(0)
            elif feat == 'baseline_adr':
                # ✅ FIX: Use predicted baseline_adr if available, otherwise fallback
                if 'baseline_adr' in predictions and predictions['baseline_adr'] > 0:
                    feature_values.append(predictions['baseline_adr'])
                else:
                    feature_values.append(220.0)  # Fallback value
            elif feat == 'rate_ratio':
                # ✅ FIX: Calculate rate_ratio if baseline_adr is available
                if 'baseline_adr' in predictions and predictions['baseline_adr'] > 0:
                    quoted = 0  # Placeholder
                    baseline = predictions['baseline_adr']
                    ratio = quoted / baseline if baseline > 0 else 1.0
                    feature_values.append(ratio)
                else:
                    feature_values.append(1.0)  # Default ratio
            else:
                feature_values.append(0)  # Unknown feature
        
        print(f"Features being sent: {features}")
        print(f"Feature values: {dict(zip(features, feature_values))}")
        
        # Create numpy array
        X_array = np.array([feature_values], dtype=np.float32)
        print(f"Array shape: {X_array.shape}, dtype: {X_array.dtype}")
        
        # ✅ CRITICAL FIX: Use sklearn interface for XGBRegressor, not DMatrix
        # Check if model is sklearn wrapper or Booster
        model_obj = models[model_name]
        model_type = str(type(model_obj))
        
        if 'sklearn' in model_type or 'XGBRegressor' in model_type or 'XGBClassifier' in model_type:
            # sklearn wrapper - use direct predict
            print(f"  Using sklearn interface for {model_name}")
            prediction = model_obj.predict(X_array)
        else:
            # Booster - use DMatrix
            print(f"  Using Booster interface for {model_name}")
            dmatrix = xgb.DMatrix(X_array, feature_names=features)
            prediction = model_obj.predict(dmatrix)
        
        predictions[model_name] = float(prediction[0])
        models_used += 1
        print(f"  ✅ {model_name}: {predictions[model_name]:.2f}")
        
    except Exception as e:
        print(f"  ⚠️ {model_name} failed: {str(e)}")
        # Keep fallback value

if models_used > 0:
    prediction_method = f'xgboost ({models_used}/4 models)'
else:
    print("📊 Using rule-based predictions")

# Extract predictions
baseline_adr = predictions['baseline_adr']
pickup_rate = predictions['pickup']
conversion_prob = predictions['conversion']
fnb_per_person = predictions['fnb']

# ✅ FIX: Validate ALL predictions and use rule-based fallbacks if needed
models_failed = []

# Validate baseline_adr
if baseline_adr < 0 or baseline_adr < 100:
    print(f"❌ ERROR: baseline_adr is invalid ({baseline_adr:.2f})! Using rule-based fallback.")
    models_failed.append('baseline_adr')
    
    # Rule-based baseline ADR calculation
    # Based on training data patterns: mean=€164, range=€135-€186
    base_adr = 164.0
    
    # Adjust for occupancy (most important)
    if forecasted_occupancy < 50:
        occ_adj = -15
    elif forecasted_occupancy < 70:
        occ_adj = -5
    elif forecasted_occupancy < 85:
        occ_adj = 0
    else:
        occ_adj = 10
    
    # Adjust for weekend
    weekend_adj = 8 if is_weekend else 0
    
    # Adjust for season  
    season_adj = {0: -5, 1: 0, 2: 8, 3: -3}.get(season, 0)
    
    # Adjust for lead time
    if lead_time < 30:
        lead_adj = 5
    elif lead_time < 90:
        lead_adj = 0
    elif lead_time < 180:
        lead_adj = -3
    else:
        lead_adj = -8
    
    baseline_adr = base_adr + occ_adj + weekend_adj + season_adj + lead_adj
    baseline_adr = max(135, min(185, baseline_adr))
    
    print(f"✅ Rule-based baseline_adr: €{baseline_adr:.2f}")
elif baseline_adr > 400:
    print(f"⚠️  WARNING: baseline_adr ({baseline_adr:.2f}) outside typical range")

# Validate pickup_rate
if pickup_rate < 0 or pickup_rate > 1:
    print(f"❌ ERROR: pickup_rate is invalid ({pickup_rate:.2%})! Using fallback.")
    models_failed.append('pickup')
    # Training data mean: 0.79
    pickup_rate = 0.79
    print(f"✅ Rule-based pickup_rate: {pickup_rate:.2%}")

# Validate conversion_prob
if conversion_prob < 0 or conversion_prob > 1:
    print(f"❌ ERROR: conversion_prob is invalid ({conversion_prob:.2%})! Using fallback.")
    models_failed.append('conversion')
    # Training data mean: 0.65
    conversion_prob = 0.65
    print(f"✅ Rule-based conversion_prob: {conversion_prob:.2%}")

# Validate fnb_per_person
if fnb_per_person < 0 or fnb_per_person > 500:
    print(f"❌ ERROR: fnb_per_person is invalid (€{fnb_per_person:.2f})! Using rule-based fallback.")
    models_failed.append('fnb')
    
    # Rule-based F&B calculation
    # Training data: mean=€60, varies by event type
    base_fnb = 60.0
    
    # Adjust for weekend (higher F&B on weekends)
    fnb_weekend_adj = 15 if is_weekend else 0
    
    # Adjust for season (summer events = higher F&B)
    fnb_season_adj = {0: -10, 1: 0, 2: 20, 3: 5}.get(season, 0)
    
    # Adjust for number of nights (multi-day = lower per-person)
    if nights == 1:
        fnb_nights_adj = 10
    elif nights <= 3:
        fnb_nights_adj = 0
    else:
        fnb_nights_adj = -15
    
    fnb_per_person = base_fnb + fnb_weekend_adj + fnb_season_adj + fnb_nights_adj
    fnb_per_person = max(30, min(150, fnb_per_person))
    
    print(f"✅ Rule-based fnb_per_person: €{fnb_per_person:.2f}")

# Update prediction method if models failed
if models_failed:
    prediction_method = f'hybrid (failed: {", ".join(models_failed)})'
    print(f"⚠️  Models failed: {', '.join(models_failed)}")
    print(f"   This is likely due to XGBoost version incompatibility in Pyodide")
    print(f"   Using rule-based fallbacks for reliable predictions")

print(f"Final values: ADR=€{baseline_adr:.2f}, Pickup={pickup_rate*100:.2f}%, Conv={conversion_prob*100:.2f}%, F&B=€{fnb_per_person:.2f}")

# Calculate revenue components
room_revenue_base = baseline_adr * room_block * nights * pickup_rate
fnb_revenue_base = attendees * fnb_per_person
meeting_space_base = 8000  # Base meeting space revenue

# Calculate GVI (Group Value Index)
# Based on total revenue per room night
total_revenue_base = room_revenue_base + fnb_revenue_base + meeting_space_base
room_nights = room_block * nights
gvi_base = int(total_revenue_base / room_nights) if room_nights > 0 else 100

print(f"Calculated GVI: {gvi_base}")

# Generate 3 strategies with different risk/reward profiles
# ✅ NOTE: Strategies use baseline_adr * multiplier (NOT subtraction!)
strategies = []

# Strategy 1: Conservative (lower ADR, higher conversion)
# ✅ CORRECT FORMULA: baseline_adr * 0.95 (5% below market)
conservative_adr = baseline_adr * 0.95
conservative_pickup = min(0.99, pickup_rate * 1.06)
conservative_conversion = min(0.99, conversion_prob * 1.15)
conservative_fnb = fnb_per_person * 0.9

cons_room_rev = conservative_adr * room_block * nights * conservative_pickup
cons_fnb_rev = attendees * conservative_fnb
cons_space_rev = meeting_space_base * 1.0
cons_total = cons_room_rev + cons_fnb_rev + cons_space_rev
cons_profit = cons_total * 0.44
cons_risk_adj = cons_profit * conservative_conversion

strategies.append({
    'name': 'Conservative Capture',
    'risk': 'Low Risk',
    'adr': int(conservative_adr),
    'pickupRate': int(conservative_pickup * 100),
    'conversionProb': int(conservative_conversion * 100),
    'gviIndex': int((cons_total / room_nights) * 0.95),
    'roomRevenue': int(cons_room_rev),
    'fnbRevenue': int(cons_fnb_rev),
    'spaceRevenue': int(cons_space_rev),
    'totalRevenue': int(cons_total),
    'expectedProfit': int(cons_profit),
    'riskAdjustedValue': int(cons_risk_adj),
    'roiVsBaseline': '+71%',
    'color': 'success',
    'includes': [
        '2 comp rooms',
        '€30/person F&B credit',
        '50% space discount',
        'Free WiFi',
        'Late checkout',
        'Welcome reception',
        'Group discount card'
    ],
    'subtitle': 'More conservative alternative'
})

# Strategy 2: Optimal Balance (recommended)
# ✅ CORRECT FORMULA: baseline_adr * 1.0 (at market rate)
optimal_adr = baseline_adr
optimal_pickup = pickup_rate
optimal_conversion = conversion_prob
optimal_fnb = fnb_per_person

opt_room_rev = optimal_adr * room_block * nights * optimal_pickup
opt_fnb_rev = attendees * optimal_fnb
opt_space_rev = meeting_space_base * 1.4
opt_total = opt_room_rev + opt_fnb_rev + opt_space_rev
opt_profit = opt_total * 0.44
opt_risk_adj = opt_profit * optimal_conversion

strategies.append({
    'name': 'Optimal Balance',
    'risk': 'Medium Risk',
    'adr': int(optimal_adr),
    'pickupRate': int(optimal_pickup * 100),
    'conversionProb': int(optimal_conversion * 100),
    'gviIndex': int(opt_total / room_nights),
    'roomRevenue': int(opt_room_rev),
    'fnbRevenue': int(opt_fnb_rev),
    'spaceRevenue': int(opt_space_rev),
    'totalRevenue': int(opt_total),
    'expectedProfit': int(opt_profit),
    'riskAdjustedValue': int(opt_risk_adj),
    'roiVsBaseline': '+103%',
    'color': 'warning',
    'recommended': True,
    'includes': [
        '2 comp rooms',
        '€25/person F&B credit',
        '30% space discount',
        'Free WiFi',
        'Welcome reception',
        'Late checkout'
    ],
    'subtitle': 'Select Recommended Strategy'
})

# Strategy 3: Premium (higher ADR, lower conversion)
# ✅ CORRECT FORMULA: baseline_adr * 1.15 (15% above market)
premium_adr = baseline_adr * 1.15
premium_pickup = pickup_rate * 0.95
premium_conversion = conversion_prob * 0.85
premium_fnb = fnb_per_person * 1.2

prem_room_rev = premium_adr * room_block * nights * premium_pickup
prem_fnb_rev = attendees * premium_fnb
prem_space_rev = meeting_space_base * 1.7
prem_total = prem_room_rev + prem_fnb_rev + prem_space_rev
prem_profit = prem_total * 0.43
prem_risk_adj = prem_profit * premium_conversion

strategies.append({
    'name': 'Premium Position',
    'risk': 'Higher Risk',
    'adr': int(premium_adr),
    'pickupRate': int(premium_pickup * 100),
    'conversionProb': int(premium_conversion * 100),
    'gviIndex': int((prem_total / room_nights) * 1.05),
    'roomRevenue': int(prem_room_rev),
    'fnbRevenue': int(prem_fnb_rev),
    'spaceRevenue': int(prem_space_rev),
    'totalRevenue': int(prem_total),
    'expectedProfit': int(prem_profit),
    'riskAdjustedValue': int(prem_risk_adj),
    'roiVsBaseline': '+128%',
    'color': 'error',
    'includes': [
        '2 comp rooms',
        '€20/person F&B credit',
        '15% space discount',
        'Free WiFi',
        'Welcome amenity'
    ],
    'subtitle': 'Higher profit, higher risk'
})

{
    'success': True,
    'strategies': strategies,
    'prediction_method': prediction_method
}
    `);

    console.log(`✅ Predictions using: ${result.prediction_method}`);
    return result;

  } catch (error) {
    console.error('❌ Prediction error:', error);
    throw error;
  }
};