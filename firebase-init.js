// Import the functions you need from the SDKs you need.
// We're using the CDN URLs for the modular SDK since no bundler is set up in the root project.
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-analytics.js";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
// IMPORTANT: It's highly recommended to use environment variables for this in a real application.
const firebaseConfig = {
  apiKey: "AIzaSyCDu1eVuupRSjZ_Y4l5BYLf7n4RNI3OpmA",
  authDomain: "mammoth-broth-co.firebaseapp.com",
  projectId: "mammoth-broth-co",
  storageBucket: "mammoth-broth-co.appspot.com",
  messagingSenderId: "893914225780",
  appId: "1:893914225780:web:e5d6e13da2c32a47438521",
  measurementId: "G-B3J5P98SG5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize and export Firebase services
const analytics = getAnalytics(app);
const db = getFirestore(app);
const functions = getFunctions(app);

export { db, functions, analytics, app };