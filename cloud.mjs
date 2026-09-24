const FIREBASE_VERSION = '12.19.0';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

export function isFirebaseConfigured(config) {
  return ['apiKey', 'authDomain', 'projectId', 'appId'].every(key => typeof config[key] === 'string' && config[key].trim());
}

export async function createCloud(config) {
  if (!isFirebaseConfigured(config)) return null;
  const [appApi, authApi, firestoreApi] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`)
  ]);
  const app = appApi.initializeApp(config);
  const auth = authApi.getAuth(app);
  const database = firestoreApi.getFirestore(app);
  const boardRef = uid => firestoreApi.doc(database, 'users', uid, 'boards', 'default');
  return {
    onAuthChange(callback) { return authApi.onAuthStateChanged(auth, callback); },
    async signIn(email, password) { return authApi.signInWithEmailAndPassword(auth, email, password); },
    async createAccount(email, password) { return authApi.createUserWithEmailAndPassword(auth, email, password); },
    async resetPassword(email) { return authApi.sendPasswordResetEmail(auth, email); },
    async signOut() { return authApi.signOut(auth); },
    async loadBoard(uid) { const snapshot = await firestoreApi.getDoc(boardRef(uid)); return snapshot.exists() ? snapshot.data() : null; },
    async saveBoard(uid, data) { return firestoreApi.setDoc(boardRef(uid), data); }
  };
}
