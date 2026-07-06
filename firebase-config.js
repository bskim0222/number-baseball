/**
 * Firebase Realtime Database Sandbox Configuration (firebase-config.js)
 * Connects the client to a shared public testing database for instant play.
 */

(function () {
    // Shared sandbox configuration (open rules enabled for testing)
    const firebaseConfig = {
        apiKey: "AIzaSyAsSaNdbOxKeYHeRe-DeMo-OnLy",
        authDomain: "toss-baseball-demo.firebaseapp.com",
        databaseURL: "https://toss-baseball-demo-default-rtdb.firebaseio.com",
        projectId: "toss-baseball-demo",
        storageBucket: "toss-baseball-demo.appspot.com",
        messagingSenderId: "123456789012",
        appId: "1:123456789012:web:a1b2c3d4e5f6g7h8"
    };

    if (typeof firebase !== 'undefined') {
        firebase.initializeApp(firebaseConfig);
        // Expose database reference globally
        window.db = firebase.database();
        console.log("Firebase initialized successfully on sandbox database.");
    } else {
        console.error("Firebase SDK not found! Offline fallback mode will be active.");
        window.db = null;
    }
})();
