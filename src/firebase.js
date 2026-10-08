import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDwsvaPmWwviTuJv2DPMvhpJq-nhtwhkiQ",
  authDomain: "hotels-analytics.firebaseapp.com",
  projectId: "hotels-analytics",
  storageBucket: "hotels-analytics.firebasestorage.app",
  messagingSenderId: "402846881119",
  appId: "1:402846881119:web:2a01c46ee2536d467112ea",
  measurementId: "G-CQ8SLTRGF2"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export default app;
