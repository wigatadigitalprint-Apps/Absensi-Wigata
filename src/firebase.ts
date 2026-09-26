import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut,
  onAuthStateChanged,
  type User 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDocFromServer,
  collection,
  query,
  where,
  onSnapshot,
  setDoc,
  deleteDoc,
  type Unsubscribe
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// CRITICAL: Initialize Firestore with database ID from config
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Connection test on boot
export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    // Non-fatal if document doesn't exist or unauthenticated read test
    return true;
  }
}

// Google Auth provider
const googleProvider = new GoogleAuthProvider();

export async function loginWithGoogle(): Promise<User> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error('Google Sign-in failed:', error);
    throw error;
  }
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export interface AttendanceRecord {
  id: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  userPhoto?: string;
  nik?: string;
  jabatan?: string;
  tanggal: string; // YYYY-MM-DD
  masuk: string | null; // HH:MM:SS
  pulang: string | null; // HH:MM:SS
  lemburMulai: string | null; // HH:MM
  lemburSelesai: string | null; // HH:MM
  lemburAlasan: string;
  lokasiMasuk: string;
  lokasiPulang: string;
  updatedAt?: string;
}

export interface UserSettings {
  jamMasuk: string;
  jamPulang: string;
  toleransi: number;
  namaPerusahaan: string;
  updatedAt?: string;
}

export interface UserProfile {
  userId: string;
  namaLengkap: string;
  nik: string;
  noHp: string;
  jabatan: string;
  alamatLokasi: string;
  userEmail?: string;
  userPhoto?: string;
  updatedAt?: string;
}

// Firestore Realtime Service for a specific user
export function subscribeToUserAttendances(
  userId: string,
  onData: (records: AttendanceRecord[]) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  const collPath = 'attendances';
  const q = query(collection(db, collPath), where('userId', '==', userId));

  return onSnapshot(
    q,
    (snapshot) => {
      const records: AttendanceRecord[] = [];
      snapshot.forEach((d) => {
        records.push(d.data() as AttendanceRecord);
      });
      onData(records);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, collPath);
    }
  );
}

// Firestore Realtime Service for Admin to view ALL employees
export function subscribeToAllAttendances(
  onData: (records: AttendanceRecord[]) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  const collPath = 'attendances';
  const q = query(collection(db, collPath));

  return onSnapshot(
    q,
    (snapshot) => {
      const records: AttendanceRecord[] = [];
      snapshot.forEach((d) => {
        records.push(d.data() as AttendanceRecord);
      });
      onData(records);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, collPath);
    }
  );
}

export function subscribeToUserSettings(
  userId: string,
  onData: (settings: UserSettings | null) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  const docPath = `settings/${userId}`;
  return onSnapshot(
    doc(db, 'settings', userId),
    (snapshot) => {
      if (snapshot.exists()) {
        onData(snapshot.data() as UserSettings);
      } else {
        onData(null);
      }
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  );
}

export async function saveAttendanceToCloud(record: AttendanceRecord, userId: string, userEmail: string = ''): Promise<void> {
  const docPath = `attendances/${record.id}`;
  try {
    const payload: AttendanceRecord = {
      ...record,
      userId,
      userEmail,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'attendances', record.id), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export async function deleteAttendanceFromCloud(recordId: string): Promise<void> {
  const docPath = `attendances/${recordId}`;
  try {
    await deleteDoc(doc(db, 'attendances', recordId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

export async function saveSettingsToCloud(userId: string, settings: UserSettings): Promise<void> {
  const docPath = `settings/${userId}`;
  try {
    await setDoc(doc(db, 'settings', userId), {
      ...settings,
      userId,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export function subscribeToUserProfile(
  userId: string,
  onData: (profile: UserProfile | null) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  const docPath = `profiles/${userId}`;
  return onSnapshot(
    doc(db, 'profiles', userId),
    (snapshot) => {
      if (snapshot.exists()) {
        onData(snapshot.data() as UserProfile);
      } else {
        onData(null);
      }
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  );
}

export async function saveUserProfileToCloud(userId: string, profile: UserProfile): Promise<void> {
  const docPath = `profiles/${userId}`;
  try {
    await setDoc(doc(db, 'profiles', userId), {
      ...profile,
      userId,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export function subscribeToAllProfiles(
  onData: (profiles: UserProfile[]) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  const collPath = 'profiles';
  const q = query(collection(db, collPath));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: UserProfile[] = [];
      snapshot.forEach((d) => {
        list.push(d.data() as UserProfile);
      });
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, collPath);
    }
  );
}

