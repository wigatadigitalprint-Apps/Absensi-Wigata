/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  onAuthStateChanged, 
  type User 
} from 'firebase/auth';
import { 
  auth, 
  testConnection, 
  loginWithGoogle, 
  logoutUser, 
  subscribeToUserAttendances, 
  subscribeToAllAttendances,
  subscribeToUserSettings, 
  subscribeToUserProfile,
  saveAttendanceToCloud, 
  deleteAttendanceFromCloud, 
  saveSettingsToCloud,
  saveUserProfileToCloud,
  type AttendanceRecord,
  type UserSettings,
  type UserProfile
} from './firebase';

const NAMA_APLIKASI = "ABSENSI WIGATA DIGITALPRINT";
const NAMA_PERUSAHAAN_DEFAULT = "WIGATA DIGITALPRINT";

const lokasiPilihanDefault = [
  'Workshop Utama - Wigata Digitalprint (Pusat Produksi)',
  'Cabang 1 - Studio Desain & Cetak Cepat',
  'Cabang 2 - Finishing & Packaging',
  'Lokasi Tugas Lapangan / Pemasangan Spanduk',
];

const daftarJabatan = [
  'Operator Mesin Indoor/Outdoor',
  'Desainer Grafis & Setting',
  'Operator Laser & Cutting Sticker',
  'Finishing & Lem Spanduk',
  'Kasir & Customer Service',
  'Admin Pembukuan & Invoice',
  'Kurir & Pengiriman',
  'Teknisi & Maintenance Mesin',
  'Kepala Workshop / Supervisor',
];

function formatTanggalIndo(tglStr: string): string {
  try {
    return new Date(tglStr + 'T00:00:00').toLocaleDateString('id-ID', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return tglStr;
  }
}

function getHHMMSS(): string {
  return new Date().toTimeString().slice(0, 8);
}

function menitDariJam(jamStr: string | null): number | null {
  if (!jamStr) return null;
  const parts = jamStr.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

function hitungSelisihMenit(mulai: string | null, selesai: string | null): number {
  if (!mulai || !selesai) return 0;
  const m1 = menitDariJam(mulai);
  const m2 = menitDariJam(selesai);
  if (m1 === null || m2 === null) return 0;
  let diff = m2 - m1;
  if (diff < 0) diff += 1440;
  return diff;
}

function formatDurasi(menit: number): string {
  if (menit <= 0) return '-';
  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  if (jam === 0) return `${sisaMenit}m`;
  if (sisaMenit === 0) return `${jam}j`;
  return `${jam}j ${sisaMenit}m`;
}

function hitungStatusKehadiran(
  record: AttendanceRecord,
  settings: UserSettings
): 'Hadir' | 'Terlambat' | 'Pulang Cepat' | 'Belum Absen' {
  if (!record.masuk) return 'Belum Absen';
  const mMasuk = menitDariJam(record.masuk);
  const mTargetMasuk = menitDariJam(settings.jamMasuk);
  const mPulang = menitDariJam(record.pulang);
  const mTargetPulang = menitDariJam(settings.jamPulang);

  if (mMasuk !== null && mTargetMasuk !== null && mMasuk > mTargetMasuk + settings.toleransi) {
    return 'Terlambat';
  }
  if (mPulang !== null && mTargetPulang !== null && mPulang < mTargetPulang) {
    return 'Pulang Cepat';
  }
  return 'Hadir';
}

const LOCAL_STORAGE_KEY = 'wigata_absensi_records';
const SETTINGS_KEY = 'wigata_absensi_settings';
const PROFILE_KEY = 'wigata_user_profile';
const ADMIN_SESSION_KEY = 'wigata_admin_session';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isCloudConnected, setIsCloudConnected] = useState<boolean>(true);
  const [isManualAdmin, setIsManualAdmin] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<'beranda' | 'riwayat' | 'lembur' | 'profil'>('beranda');

  // Admin Detection: either by email wigatadigitalprint@gmail.com or manual admin credential login
  const isAdmin = isManualAdmin || (currentUser?.email === 'wigatadigitalprint@gmail.com');
  const [adminViewAll, setAdminViewAll] = useState<boolean>(false);

  // Settings
  const [settings, setSettings] = useState<UserSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      jamMasuk: '08:00',
      jamPulang: '17:00',
      toleransi: 15,
      namaPerusahaan: NAMA_PERUSAHAAN_DEFAULT,
    };
  });

  // Employee Profile
  const [userProfile, setUserProfile] = useState<UserProfile>(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      userId: 'guest',
      namaLengkap: '',
      nik: '',
      noHp: '',
      jabatan: daftarJabatan[0],
      alamatLokasi: lokasiPilihanDefault[0],
    };
  });

  // Records (Personal & All Staff for Admin)
  const [records, setRecords] = useState<AttendanceRecord[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  });
  const [allRecords, setAllRecords] = useState<AttendanceRecord[]>([]);

  // Filter & Search
  const [filterRentang, setFilterRentang] = useState<'minggu' | 'bulan' | 'semua'>('semua');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterJabatan, setFilterJabatan] = useState<string>('semua');

  // Modals & Messages
  const [editingRecord, setEditingRecord] = useState<AttendanceRecord | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [showAdminLoginModal, setShowAdminLoginModal] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [celebrationModal, setCelebrationModal] = useState<{ type: 'masuk' | 'pulang'; time: string } | null>(null);

  // Admin login credentials input
  const [adminUsername, setAdminUsername] = useState<string>('');
  const [adminPassword, setAdminPassword] = useState<string>('');

  // Overtime Form
  const [lemburMulai, setLemburMulai] = useState<string>('18:00');
  const [lemburSelesai, setLemburSelesai] = useState<string>('20:00');
  const [lemburAlasan, setLemburAlasan] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => setToastMessage(msg);

  // 1. Test Firestore Connection on Boot
  useEffect(() => {
    testConnection().then((connected) => setIsCloudConnected(connected));
  }, []);

  // 2. Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (user) {
        // If profile doesn't have name yet, use Google name
        setUserProfile((prev) => ({
          ...prev,
          userId: user.uid,
          namaLengkap: prev.namaLengkap || user.displayName || '',
        }));
      }
    });
    return () => unsubscribe();
  }, []);

  // 3. Realtime Sync when User is Logged In
  useEffect(() => {
    if (!currentUser) return;

    // Listen to personal attendances
    const unsubAttendances = subscribeToUserAttendances(
      currentUser.uid,
      (cloudRecords) => {
        if (cloudRecords && cloudRecords.length > 0) {
          setRecords(cloudRecords);
          try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cloudRecords));
          } catch {}
        }
      },
      (err) => console.warn('Attendance sync error:', err)
    );

    // Listen to User Profile
    const unsubProfile = subscribeToUserProfile(
      currentUser.uid,
      (cloudProfile) => {
        if (cloudProfile) {
          setUserProfile(cloudProfile);
          try {
            localStorage.setItem(PROFILE_KEY, JSON.stringify(cloudProfile));
          } catch {}
        }
      },
      (err) => console.warn('Profile sync error:', err)
    );

    // Listen to Settings
    const unsubSettings = subscribeToUserSettings(
      currentUser.uid,
      (cloudSettings) => {
        if (cloudSettings) {
          setSettings(cloudSettings);
        }
      },
      (err) => console.warn('Settings sync error:', err)
    );

    return () => {
      unsubAttendances();
      unsubProfile();
      unsubSettings();
    };
  }, [currentUser]);

  // 4. Admin realtime listener to all employees
  useEffect(() => {
    if (!isAdmin) return;
    const unsubAll = subscribeToAllAttendances(
      (allData) => {
        setAllRecords(allData);
      },
      (err) => console.warn('Admin all attendances listener warning:', err)
    );
    return () => unsubAll();
  }, [isAdmin]);

  // Cache backups
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(records));
    } catch {}
  }, [records]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(userProfile));
    } catch {}
  }, [userProfile]);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentDate(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Toast auto-dismiss
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  // Today's record
  const todayDateStr = new Date().toISOString().slice(0, 10);
  const todayRecord = useMemo(
    () => records.find((r) => r.tanggal === todayDateStr) || null,
    [records, todayDateStr]
  );

  const durasiKerjaHariIni = useMemo(
    () => (todayRecord?.masuk && todayRecord?.pulang ? hitungSelisihMenit(todayRecord.masuk, todayRecord.pulang) : 0),
    [todayRecord]
  );

  const statusHariIni = useMemo(
    () => (todayRecord ? hitungStatusKehadiran(todayRecord, settings) : 'Belum Absen'),
    [todayRecord, settings]
  );

  const durasiLemburInput = useMemo(
    () => hitungSelisihMenit(lemburMulai, lemburSelesai),
    [lemburMulai, lemburSelesai]
  );

  // Active records: if Admin and adminViewAll is ON, display all employee records
  const activeRecords = isAdmin && adminViewAll ? allRecords : records;

  // Filtered records for History
  const filteredRecords = useMemo(() => {
    let list = [...activeRecords];
    const now = new Date();

    if (filterRentang === 'minggu') {
      const batas = new Date();
      batas.setDate(now.getDate() - 7);
      list = list.filter((r) => new Date(r.tanggal) >= batas);
    } else if (filterRentang === 'bulan') {
      list = list.filter((r) => {
        const d = new Date(r.tanggal);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
    }

    if (filterJabatan !== 'semua') {
      list = list.filter((r) => r.jabatan === filterJabatan);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (r) =>
          r.tanggal.includes(q) ||
          (r.userName && r.userName.toLowerCase().includes(q)) ||
          (r.nik && r.nik.toLowerCase().includes(q)) ||
          (r.jabatan && r.jabatan.toLowerCase().includes(q)) ||
          (r.userEmail && r.userEmail.toLowerCase().includes(q)) ||
          (r.lokasiMasuk && r.lokasiMasuk.toLowerCase().includes(q)) ||
          hitungStatusKehadiran(r, settings).toLowerCase().includes(q)
      );
    }

    return list.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
  }, [activeRecords, filterRentang, filterJabatan, searchQuery, settings]);

  const overtimeList = useMemo(
    () => activeRecords.filter((r) => r.lemburMulai && r.lemburSelesai).sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1)),
    [activeRecords]
  );

  const statistik = useMemo(() => {
    const now = new Date();
    const recordsBulanIni = activeRecords.filter((r) => {
      const d = new Date(r.tanggal);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });

    const totalJamBulan = recordsBulanIni.reduce(
      (acc, r) => (r.masuk && r.pulang ? acc + hitungSelisihMenit(r.masuk, r.pulang) : acc),
      0
    );

    const totalLembur = activeRecords.reduce(
      (acc, r) => (r.lemburMulai && r.lemburSelesai ? acc + hitungSelisihMenit(r.lemburMulai, r.lemburSelesai) : acc),
      0
    );

    const terlambatCount = activeRecords.filter((r) => hitungStatusKehadiran(r, settings) === 'Terlambat').length;

    return {
      totalJamBulan,
      totalLembur,
      terlambatCount,
      totalHari: activeRecords.length,
    };
  }, [activeRecords, settings]);

  // GPS Geolocation Detection
  const handleDetectGPS = () => {
    if (!navigator.geolocation) {
      showToast('Perangkat tidak mendukung GPS');
      return;
    }
    showToast('Sedang mendeteksi koordinat GPS...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lng = pos.coords.longitude.toFixed(5);
        const acc = Math.round(pos.coords.accuracy);
        const gpsLabel = `Koordinat (${lat}, ${lng}) Akurasi ±${acc}m`;
        setUserProfile((prev) => ({
          ...prev,
          alamatLokasi: prev.alamatLokasi ? `${prev.alamatLokasi.split('[GPS')[0].trim()} [GPS ±${acc}m: ${lat}, ${lng}]` : gpsLabel,
        }));
        showToast(`✓ Lokasi GPS terverifikasi (±${acc}m)`);
      },
      (err) => {
        showToast('Gagal membaca GPS: Pastikan izin lokasi aktif');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  // Handlers
  const handleAbsenMasuk = async () => {
    if (todayRecord?.masuk) {
      showToast('Anda sudah melakukan absen masuk hari ini.');
      return;
    }

    const lokasiSaatIni = userProfile.alamatLokasi?.trim() || lokasiPilihanDefault[0];
    const jamSekarang = getHHMMSS();
    const namaKaryawan = userProfile.namaLengkap.trim() || currentUser?.displayName || 'Karyawan Wigata';

    const newRecord: AttendanceRecord = {
      id: todayRecord ? todayRecord.id : `wgt-${todayDateStr}-${Date.now().toString().slice(-4)}`,
      userId: currentUser?.uid || 'guest-' + Date.now().toString().slice(-4),
      userEmail: currentUser?.email || '',
      userName: namaKaryawan,
      userPhoto: currentUser?.photoURL || '',
      nik: userProfile.nik || '',
      jabatan: userProfile.jabatan || '',
      tanggal: todayDateStr,
      masuk: jamSekarang,
      pulang: null,
      lemburMulai: null,
      lemburSelesai: null,
      lemburAlasan: '',
      lokasiMasuk: lokasiSaatIni,
      lokasiPulang: '',
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => [newRecord, ...prev.filter((r) => r.tanggal !== todayDateStr)]);
    setCelebrationModal({ type: 'masuk', time: jamSekarang.slice(0, 5) });
    showToast(`✓ Absen masuk tercatat ${jamSekarang.slice(0, 5)} WIB`);

    if (currentUser) {
      try {
        await saveAttendanceToCloud(newRecord, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving to cloud:', err);
      }
    }
  };

  const handleAbsenPulang = async () => {
    if (!todayRecord?.masuk) {
      showToast('Harap absen masuk terlebih dahulu sebelum absen pulang.');
      return;
    }
    if (todayRecord.pulang) {
      showToast('Anda sudah melakukan absen pulang hari ini.');
      return;
    }

    const lokasiSaatIni = userProfile.alamatLokasi?.trim() || lokasiPilihanDefault[0];
    const jamSekarang = getHHMMSS();
    const updated: AttendanceRecord = {
      ...todayRecord,
      userName: userProfile.namaLengkap.trim() || todayRecord.userName || 'Karyawan Wigata',
      nik: userProfile.nik || todayRecord.nik || '',
      jabatan: userProfile.jabatan || todayRecord.jabatan || '',
      pulang: jamSekarang,
      lokasiPulang: lokasiSaatIni,
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => prev.map((r) => (r.tanggal === todayDateStr ? updated : r)));
    setCelebrationModal({ type: 'pulang', time: jamSekarang.slice(0, 5) });
    showToast(`✓ Absen pulang tercatat ${jamSekarang.slice(0, 5)} WIB`);

    if (currentUser) {
      try {
        await saveAttendanceToCloud(updated, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving to cloud:', err);
      }
    }
  };

  const handleAjukanLembur = async () => {
    if (!todayRecord) {
      showToast('Silakan absen masuk hari ini terlebih dahulu.');
      return;
    }
    if (!lemburMulai || !lemburSelesai) {
      showToast('Isi jam mulai dan jam selesai lembur.');
      return;
    }
    if (durasiLemburInput <= 0) {
      showToast('Jam selesai lembur harus lebih lambat dari jam mulai.');
      return;
    }

    const updated: AttendanceRecord = {
      ...todayRecord,
      lemburMulai,
      lemburSelesai,
      lemburAlasan: lemburAlasan.trim() || 'Lembur cetak lemburan',
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => prev.map((r) => (r.tanggal === todayDateStr ? updated : r)));
    showToast(`✓ Lembur ${formatDurasi(durasiLemburInput)} berhasil dicatat`);
    setLemburAlasan('');

    if (currentUser) {
      try {
        await saveAttendanceToCloud(updated, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving overtime to cloud:', err);
      }
    }
  };

  // Only Admin can delete!
  const handleDeleteRecord = async (recordId: string) => {
    if (!isAdmin) {
      showToast('Akses ditolak: Hanya Admin yang dapat menghapus data absensi');
      return;
    }

    if (!confirm('Admin: Anda yakin ingin menghapus data absensi ini?')) return;

    setRecords((prev) => prev.filter((r) => r.id !== recordId));
    setAllRecords((prev) => prev.filter((r) => r.id !== recordId));
    showToast('✓ Data absensi berhasil dihapus oleh Admin');

    if (currentUser) {
      try {
        await deleteAttendanceFromCloud(recordId);
      } catch (err) {
        console.error('Error deleting from cloud:', err);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!editingRecord) return;
    setRecords((prev) => prev.map((r) => (r.id === editingRecord.id ? editingRecord : r)));
    setAllRecords((prev) => prev.map((r) => (r.id === editingRecord.id ? editingRecord : r)));
    showToast('✓ Perubahan absensi disimpan');

    if (currentUser) {
      try {
        await saveAttendanceToCloud(editingRecord, editingRecord.userId || currentUser.uid, editingRecord.userEmail || '');
      } catch (err) {
        console.error('Error updating to cloud:', err);
      }
    }
    setEditingRecord(null);
  };

  const handleSaveProfile = async () => {
    if (!userProfile.namaLengkap.trim()) {
      showToast('Harap isi Nama Lengkap karyawan');
      return;
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(userProfile));
    showToast('✓ Data diri & alamat lokasi karyawan berhasil disimpan');

    if (currentUser) {
      try {
        await saveUserProfileToCloud(currentUser.uid, userProfile);
        showToast('✓ Data profil tersinkron ke Cloud Firestore');
      } catch (err) {
        console.error('Error saving profile to cloud:', err);
      }
    }
  };

  // Manual Admin Login handler (user: admin, pass: admin)
  const handleAdminLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (adminUsername === 'admin' && adminPassword === 'admin') {
      setIsManualAdmin(true);
      sessionStorage.setItem(ADMIN_SESSION_KEY, 'true');
      setShowAdminLoginModal(false);
      setAdminUsername('');
      setAdminPassword('');
      setAdminViewAll(true);
      showToast('✓ Selamat datang Admin Wigata Digitalprint!');
    } else {
      showToast('Username atau password admin salah!');
    }
  };

  const handleAdminLogout = () => {
    setIsManualAdmin(false);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminViewAll(false);
    showToast('Keluar dari sesi Admin');
  };

  const handleGoogleLogin = async () => {
    try {
      showToast('Membuka login Google...');
      const user = await loginWithGoogle();
      showToast(`✓ Selamat datang, ${user.displayName || user.email}!`);
    } catch (err) {
      console.error('Google login error:', err);
      showToast('Login dibatalkan');
    }
  };

  const handleGoogleLogout = async () => {
    try {
      await logoutUser();
      showToast('Berhasil logout Google');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleExportCSV = () => {
    const headers = [
      'ID',
      'Tanggal',
      'Nama Karyawan',
      'NIK',
      'Jabatan / Divisi',
      'Email Karyawan',
      'Jam Masuk',
      'Jam Pulang',
      'Durasi Kerja (Menit)',
      'Lembur Mulai',
      'Lembur Selesai',
      'Durasi Lembur (Menit)',
      'Alasan Lembur',
      'Status Kehadiran',
      'Lokasi Masuk',
      'Lokasi Pulang',
    ];

    const rows = filteredRecords.map((r) => {
      const durKerja = r.masuk && r.pulang ? hitungSelisihMenit(r.masuk, r.pulang) : 0;
      const durLembur = r.lemburMulai && r.lemburSelesai ? hitungSelisihMenit(r.lemburMulai, r.lemburSelesai) : 0;
      const st = hitungStatusKehadiran(r, settings);

      return [
        r.id,
        r.tanggal,
        `"${(r.userName || '').replace(/"/g, '""')}"`,
        `"${(r.nik || '').replace(/"/g, '""')}"`,
        `"${(r.jabatan || '').replace(/"/g, '""')}"`,
        `"${(r.userEmail || '').replace(/"/g, '""')}"`,
        r.masuk || '',
        r.pulang || '',
        durKerja.toString(),
        r.lemburMulai || '',
        r.lemburSelesai || '',
        durLembur.toString(),
        `"${(r.lemburAlasan || '').replace(/"/g, '""')}"`,
        st,
        `"${(r.lokasiMasuk || '').replace(/"/g, '""')}"`,
        `"${(r.lokasiPulang || '').replace(/"/g, '""')}"`,
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rekap_absensi_wigata_${todayDateStr}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('✓ Laporan CSV berhasil diunduh');
  };

  const handleSalinLaporan = async () => {
    const text = filteredRecords
      .map((r) => {
        const durKerja = r.masuk && r.pulang ? formatDurasi(hitungSelisihMenit(r.masuk, r.pulang)) : '-';
        const durLembur = r.lemburMulai && r.lemburSelesai ? formatDurasi(hitungSelisihMenit(r.lemburMulai, r.lemburSelesai)) : '-';
        return `${formatTanggalIndo(r.tanggal)} | ${r.userName || 'Karyawan'} (${r.jabatan || '-'}) | Masuk: ${r.masuk || '-'} | Pulang: ${r.pulang || '-'} | Kerja: ${durKerja} | Lembur: ${durLembur} [${hitungStatusKehadiran(r, settings)}] | Lokasi: ${r.lokasiMasuk || '-'}`;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showToast('✓ Laporan disalin ke clipboard');
    } catch {
      showToast('Gagal menyalin');
    }
  };

  const timeParts = currentDate.toLocaleTimeString('id-ID', { hour12: false }).split(':');
  const greeting =
    currentDate.getHours() < 11
      ? 'Selamat Pagi'
      : currentDate.getHours() < 15
      ? 'Selamat Siang'
      : currentDate.getHours() < 18
      ? 'Selamat Sore'
      : 'Selamat Malam';

  const appShareUrl = typeof window !== 'undefined' ? window.location.origin : 'https://ais-dev-zrzfdpduo77fhn43hrbwfz-206443197156.asia-southeast1.run.app';

  return (
    <div className="min-h-[100dvh] bg-[#e6e9f0] md:bg-[#dfe3ec] flex justify-center antialiased text-slate-900 selection:bg-indigo-100">
      <div className="w-full max-w-[430px] bg-[#f6f7fb] min-h-[100dvh] md:min-h-[90dvh] md:my-6 md:rounded-[40px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_32px_80px_rgba(0,0,0,0.18)] overflow-hidden relative flex flex-col border border-white/60">
        
        {/* Top iOS / Mobile Bar */}
        <div 
          className="h-[44px] md:h-[36px] bg-[#f6f7fb] px-5 flex items-center justify-between text-[13px] font-bold shrink-0"
          style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}
        >
          <span className="font-mono tracking-wide">{timeParts[0]}:{timeParts[1]}</span>
          <div className="flex items-center gap-1.5">
            {isAdmin ? (
              <span className="flex items-center gap-1 text-[10px] font-black text-amber-900 bg-amber-100 px-2 py-0.5 rounded-full border border-amber-300">
                👑 ADMIN
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-bold text-slate-700 bg-slate-200 px-2 py-0.5 rounded-full">
                KARYAWAN
              </span>
            )}
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Online
            </span>
          </div>
        </div>

        {/* Brand Header */}
        <div className="px-5 pt-1 pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-indigo-700 via-blue-600 to-indigo-900 text-white grid place-items-center font-black text-[15px] shadow-md shrink-0">
                W
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-wider text-indigo-600 uppercase leading-none">
                  {NAMA_APLIKASI}
                </p>
                <p className="text-[14px] font-black leading-tight mt-0.5 tracking-tight truncate max-w-[190px]">
                  {userProfile.namaLengkap.trim() || currentUser?.displayName || 'Karyawan Percetakan'}
                </p>
                <p className="text-[10px] text-slate-500 truncate max-w-[190px]">
                  {userProfile.jabatan || 'Operator Cetak'} {userProfile.nik ? `• ${userProfile.nik}` : ''}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowShareModal(true)}
                className="h-8 px-2.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[11px] font-bold flex items-center gap-1 shadow-sm active:scale-95 transition"
                title="Bagikan ke HP Karyawan"
              >
                <span>📲 Share</span>
              </button>
              {isAdmin ? (
                <button
                  onClick={handleAdminLogout}
                  className="h-8 px-2.5 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black shadow-sm active:scale-95 transition"
                  title="Klik untuk keluar mode Admin"
                >
                  Admin ✓
                </button>
              ) : (
                <button
                  onClick={() => setShowAdminLoginModal(true)}
                  className="h-8 px-2.5 rounded-full bg-slate-900 text-white text-[10px] font-bold shadow-sm active:scale-95 transition"
                >
                  Login Admin
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable Main View */}
        <main 
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 pb-[112px] scrollbar-none"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          {/* TAB 1: BERANDA */}
          {activeTab === 'beranda' && (
            <div className="space-y-4 pt-1">
              
              {/* Employee Active Location Badge */}
              <div className="rounded-[18px] bg-white border border-slate-200 p-3 shadow-sm flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-8 w-8 rounded-xl bg-indigo-50 text-indigo-600 grid place-items-center text-[15px] shrink-0 font-bold">
                    📍
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase font-bold text-slate-400">Lokasi Penempatan Anda</p>
                    <p className="text-[12px] font-bold text-slate-800 truncate">
                      {userProfile.alamatLokasi || lokasiPilihanDefault[0]}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setActiveTab('profil')}
                  className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 whitespace-nowrap bg-indigo-50 px-2.5 py-1 rounded-full"
                >
                  Ubah
                </button>
              </div>

              {/* Big Digital Clock Card */}
              <div className="rounded-[28px] bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 text-white p-5 shadow-[0_12px_32px_rgba(0,0,0,0.25)] relative overflow-hidden">
                <div className="absolute -top-16 -right-16 h-48 w-48 rounded-full bg-gradient-to-br from-indigo-500/30 to-blue-500/20 blur-2xl" />
                <div className="relative z-10">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] tracking-[0.2em] text-white/50 font-bold uppercase">
                      WAKTU PRODUKSI • WIB
                    </p>
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                      <span className="text-[10px] text-white/70 font-semibold">DATABASE LIVE</span>
                    </div>
                  </div>

                  <div className="mt-4 flex items-baseline justify-center gap-1">
                    <span className="font-mono text-[44px] font-black tracking-[-0.04em] leading-none">{timeParts[0]}</span>
                    <span className="font-mono text-[44px] font-black text-white/20 leading-none animate-pulse">:</span>
                    <span className="font-mono text-[44px] font-black tracking-[-0.04em] leading-none">{timeParts[1]}</span>
                    <span className="font-mono text-[22px] font-bold text-white/40 ml-2 mb-1 tracking-widest">{timeParts[2]}</span>
                  </div>

                  <p className="text-center text-[12px] text-white/70 mt-3 font-medium capitalize">
                    {currentDate.toLocaleDateString('id-ID', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-white/10 border border-white/10 px-3 py-2 text-center">
                      <p className="text-[10px] text-white/50 uppercase font-semibold">Shift Normal</p>
                      <p className="text-[11px] font-bold mt-0.5">{settings.jamMasuk} - {settings.jamPulang}</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 border border-white/10 px-3 py-2 text-center">
                      <p className="text-[10px] text-white/50 uppercase font-semibold">Toleransi</p>
                      <p className="text-[11px] font-bold mt-0.5">{settings.toleransi} menit</p>
                    </div>
                    <div className="rounded-2xl bg-white text-slate-900 px-3 py-2 text-center font-bold">
                      <p className="text-[10px] text-slate-500 uppercase font-semibold">Status Hari Ini</p>
                      <p className="text-[11px] mt-0.5 truncate">{statusHariIni}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Today's Status Box */}
              <div className="rounded-[24px] bg-white border border-slate-200/70 shadow-[0_8px_24px_rgba(0,0,0,0.06)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold">Absensi Anda Hari Ini</h3>
                  <span
                    className={`px-3 py-1 rounded-full text-[11px] font-bold border ${
                      statusHariIni === 'Hadir'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : statusHariIni === 'Terlambat'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : statusHariIni === 'Pulang Cepat'
                        ? 'bg-orange-50 text-orange-700 border-orange-200'
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}
                  >
                    {statusHariIni}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2.5">
                  <div className="rounded-[18px] bg-[#f6f7fb] border border-slate-100 p-3">
                    <p className="text-[10px] font-bold tracking-wide text-slate-500 uppercase">Masuk</p>
                    <p className="mt-2 font-mono text-[14px] font-black">{todayRecord?.masuk?.slice(0, 5) || '--:--'}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{todayRecord?.masuk ? '✓ Tercatat' : 'Belum Absen'}</p>
                  </div>
                  <div className="rounded-[18px] bg-[#f6f7fb] border border-slate-100 p-3">
                    <p className="text-[10px] font-bold tracking-wide text-slate-500 uppercase">Pulang</p>
                    <p className="mt-2 font-mono text-[14px] font-black">{todayRecord?.pulang?.slice(0, 5) || '--:--'}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{todayRecord?.pulang ? '✓ Selesai' : 'Menunggu'}</p>
                  </div>
                  <div className="rounded-[18px] bg-indigo-50 border border-indigo-100 p-3">
                    <p className="text-[10px] font-bold tracking-wide text-indigo-600 uppercase">Total Jam</p>
                    <p className="mt-2 text-[14px] font-black text-indigo-900">{durasiKerjaHariIni ? formatDurasi(durasiKerjaHariIni) : '--'}</p>
                    <p className="text-[10px] text-indigo-400 mt-1">{durasiKerjaHariIni ? `${durasiKerjaHariIni} m` : 'Auto'}</p>
                  </div>
                </div>

                {/* Location indicator */}
                <div className="mt-3 flex items-center justify-between rounded-2xl bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-600">
                  <span className="truncate max-w-[240px]">
                    📍 {todayRecord?.lokasiMasuk || userProfile.alamatLokasi || lokasiPilihanDefault[0]}
                  </span>
                  <button
                    onClick={handleDetectGPS}
                    className="text-indigo-600 font-bold hover:underline shrink-0 text-[10px] ml-1"
                  >
                    Cek GPS
                  </button>
                </div>
              </div>

              {/* Big Action Buttons */}
              <div className="space-y-3 pt-1">
                <button
                  onClick={handleAbsenMasuk}
                  disabled={!!todayRecord?.masuk}
                  className={`w-full h-[64px] rounded-[20px] font-black text-[15px] tracking-wide flex items-center justify-center gap-3 transition-all active:scale-[0.98] touch-manipulation ${
                    todayRecord?.masuk
                      ? 'bg-slate-200 text-slate-400 border border-slate-200 cursor-not-allowed'
                      : 'bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-[0_12px_24px_rgba(79,70,229,0.35)]'
                  }`}
                >
                  <span className="h-9 w-9 rounded-full bg-white/20 grid place-items-center text-[18px]">↗</span>
                  <span className="flex flex-col items-start leading-none">
                    <span>ABSEN MASUK</span>
                    <span className="text-[10px] font-semibold opacity-80 tracking-normal mt-1">
                      {todayRecord?.masuk ? `Selesai (${todayRecord.masuk.slice(0, 5)})` : `Jam kerja: ${settings.jamMasuk}`}
                    </span>
                  </span>
                </button>

                <button
                  onClick={handleAbsenPulang}
                  disabled={!todayRecord?.masuk || !!todayRecord?.pulang}
                  className={`w-full h-[64px] rounded-[20px] font-black text-[15px] tracking-wide flex items-center justify-center gap-3 transition-all active:scale-[0.98] touch-manipulation ${
                    !todayRecord?.masuk || todayRecord?.pulang
                      ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                      : 'bg-gradient-to-br from-orange-500 via-amber-500 to-orange-600 text-white shadow-[0_12px_24px_rgba(249,115,22,0.35)]'
                  }`}
                >
                  <span className="h-9 w-9 rounded-full bg-white/20 grid place-items-center text-[18px]">↙</span>
                  <span className="flex flex-col items-start leading-none">
                    <span>ABSEN PULANG</span>
                    <span className="text-[10px] font-semibold opacity-80 tracking-normal mt-1">
                      {todayRecord?.pulang ? `Selesai (${todayRecord.pulang.slice(0, 5)})` : `Jam pulang: ${settings.jamPulang}`}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: RIWAYAT */}
          {activeTab === 'riwayat' && (
            <div className="space-y-4 pt-1">
              
              {/* Admin Mode Switch Banner */}
              {isAdmin ? (
                <div className="bg-slate-900 text-white rounded-[22px] p-3 shadow-md border border-slate-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="h-8 w-8 rounded-xl bg-amber-400/20 text-amber-400 grid place-items-center text-[15px]">
                        👑
                      </span>
                      <div>
                        <p className="text-[12px] font-black leading-tight">Mode Admin Wigata</p>
                        <p className="text-[10px] text-white/60 mt-0.5">
                          {adminViewAll
                            ? `Memantau ${allRecords.length} data seluruh karyawan`
                            : 'Melihat riwayat absensi Anda pribadi'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setAdminViewAll(!adminViewAll)}
                      className={`h-8 px-3 rounded-full text-[11px] font-bold transition-all shadow-sm ${
                        adminViewAll
                          ? 'bg-amber-400 text-slate-950 font-black'
                          : 'bg-white/10 text-white border border-white/20'
                      }`}
                    >
                      {adminViewAll ? '✓ Semua Karyawan' : 'Lihat Semua Karyawan'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-indigo-50 border border-indigo-100 rounded-[20px] p-3 flex items-center justify-between text-indigo-900">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]">👤</span>
                    <div>
                      <p className="text-[11px] font-bold">Akun Karyawan (Hanya Lihat)</p>
                      <p className="text-[10px] text-indigo-700">Karyawan tidak memiliki hak akses menghapus riwayat</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Filter Pills & Search */}
              <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 pb-1">
                {(['minggu', 'bulan', 'semua'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setFilterRentang(r)}
                    className={`h-9 px-4 rounded-full text-[12px] font-bold whitespace-nowrap border transition active:scale-[0.98] ${
                      filterRentang === r
                        ? 'bg-slate-900 text-white border-slate-900 shadow'
                        : 'bg-white text-slate-600 border-slate-200'
                    }`}
                  >
                    {r === 'minggu' ? 'Minggu Ini' : r === 'bulan' ? 'Bulan Ini' : 'Semua'}
                  </button>
                ))}
                <div className="relative ml-auto">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Cari nama/tgl..."
                    className="h-9 w-[130px] rounded-full border border-slate-200 bg-white pl-8 pr-3 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[12px]">⌕</span>
                </div>
              </div>

              {/* Monthly Stats Cards */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-[18px] bg-white border border-slate-200 p-3 shadow-sm">
                  <p className="text-[10px] uppercase font-bold text-slate-400">Total Kerja</p>
                  <p className="mt-1 text-[15px] font-black">{formatDurasi(statistik.totalJamBulan)}</p>
                </div>
                <div className="rounded-[18px] bg-white border border-slate-200 p-3 shadow-sm">
                  <p className="text-[10px] uppercase font-bold text-slate-400">Total Lembur</p>
                  <p className="mt-1 text-[15px] font-black">{formatDurasi(statistik.totalLembur)}</p>
                </div>
                <div className="rounded-[18px] bg-white border border-slate-200 p-3 shadow-sm">
                  <p className="text-[10px] uppercase font-bold text-slate-400">Terlambat</p>
                  <p className="mt-1 text-[15px] font-black">{statistik.terlambatCount}x</p>
                </div>
              </div>

              {/* Export and Copy Quick Actions */}
              <div className="flex gap-2">
                <button
                  onClick={handleExportCSV}
                  className="flex-1 h-10 rounded-2xl bg-white border border-slate-200 text-slate-700 font-bold text-[11px] flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition"
                >
                  <span>📥 Export CSV</span>
                </button>
                <button
                  onClick={handleSalinLaporan}
                  className="flex-1 h-10 rounded-2xl bg-white border border-slate-200 text-slate-700 font-bold text-[11px] flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition"
                >
                  <span>📋 Salin Ringkasan</span>
                </button>
              </div>

              {/* Attendance Card List */}
              <div className="space-y-3">
                {filteredRecords.map((r) => {
                  const durKerja = r.masuk && r.pulang ? hitungSelisihMenit(r.masuk, r.pulang) : 0;
                  const durLembur = r.lemburMulai && r.lemburSelesai ? hitungSelisihMenit(r.lemburMulai, r.lemburSelesai) : 0;
                  const st = hitungStatusKehadiran(r, settings);

                  return (
                    <div
                      key={r.id}
                      className="rounded-[22px] bg-white border border-slate-200/70 shadow-[0_6px_20px_rgba(0,0,0,0.05)] p-4 active:scale-[0.99] transition"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="h-11 w-11 rounded-2xl bg-slate-900 text-white grid place-items-center font-bold text-[12px] shrink-0">
                            {new Date(r.tanggal).getDate()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-[13px] font-bold text-slate-900 truncate">
                                {r.userName || 'Karyawan'}
                              </p>
                              {r.jabatan && (
                                <span className="bg-indigo-50 text-indigo-700 text-[9px] font-bold px-2 py-0.5 rounded-full border border-indigo-100">
                                  {r.jabatan}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {formatTanggalIndo(r.tanggal)} {r.nik ? `• ${r.nik}` : ''}
                            </p>
                          </div>
                        </div>

                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border shrink-0 ${
                            st === 'Hadir'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : st === 'Terlambat'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : st === 'Pulang Cepat'
                              ? 'bg-orange-50 text-orange-700 border-orange-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}
                        >
                          {st}
                        </span>
                      </div>

                      {/* Detail Times */}
                      <div className="mt-4 grid grid-cols-3 gap-2">
                        <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-2.5 text-center">
                          <p className="text-[9px] text-slate-400 font-bold uppercase">Masuk</p>
                          <p className="mt-1 font-mono text-[13px] font-black">{r.masuk?.slice(0, 5) || '--:--'}</p>
                        </div>
                        <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-2.5 text-center">
                          <p className="text-[9px] text-slate-400 font-bold uppercase">Pulang</p>
                          <p className="mt-1 font-mono text-[13px] font-black">{r.pulang?.slice(0, 5) || '--:--'}</p>
                        </div>
                        <div className="rounded-2xl bg-indigo-50 border border-indigo-100 p-2.5 text-center">
                          <p className="text-[9px] text-indigo-400 font-bold uppercase">Total Jam</p>
                          <p className="mt-1 text-[13px] font-black text-indigo-900">{durKerja ? formatDurasi(durKerja) : '-'}</p>
                        </div>
                      </div>

                      {/* Location string */}
                      <div className="mt-2 text-[10px] text-slate-500 truncate bg-slate-50 px-2.5 py-1.5 rounded-xl border border-slate-100">
                        📍 Lokasi: {r.lokasiMasuk || '-'}
                      </div>

                      {durLembur > 0 && (
                        <div className="mt-2 rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2 flex items-center justify-between">
                          <p className="text-[11px] font-semibold text-amber-800">
                            Lembur {formatDurasi(durLembur)} ({r.lemburMulai}-{r.lemburSelesai})
                          </p>
                          <p className="text-[10px] text-amber-600 truncate max-w-[120px]">{r.lemburAlasan}</p>
                        </div>
                      )}

                      {/* Action buttons: Only ADMIN can delete and edit! Karyawan cannot delete! */}
                      {isAdmin ? (
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => setEditingRecord(r)}
                            className="flex-1 h-10 rounded-full bg-white border border-slate-200 text-[12px] font-bold active:scale-[0.98] transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteRecord(r.id)}
                            className="h-10 px-4 rounded-full bg-rose-50 border border-rose-100 text-rose-600 text-[12px] font-bold active:scale-[0.98] transition"
                            title="Hapus rekapan (Khusus Admin)"
                          >
                            Hapus
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {filteredRecords.length === 0 && (
                  <div className="py-16 text-center text-slate-400 text-[13px]">
                    Belum ada riwayat absensi
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: LEMBUR */}
          {activeTab === 'lembur' && (
            <div className="space-y-4 pt-1">
              <div className="rounded-[26px] bg-white border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[14px] font-bold">Form Pengajuan Lembur</h3>
                  <span className="text-[11px] px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 font-bold">
                    Durasi: {formatDurasi(durasiLemburInput)}
                  </span>
                </div>

                <div className="mt-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[12px] font-semibold text-slate-700">Mulai Lembur</span>
                      <input
                        type="time"
                        value={lemburMulai}
                        onChange={(e) => setLemburMulai(e.target.value)}
                        className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[12px] font-semibold text-slate-700">Selesai Lembur</span>
                      <input
                        type="time"
                        value={lemburSelesai}
                        onChange={(e) => setLemburSelesai(e.target.value)}
                        className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>
                  </div>

                  <div className="rounded-2xl bg-indigo-50 border border-indigo-100 px-4 py-3 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-indigo-700">Total Durasi Lembur</span>
                    <span className="text-[14px] font-black text-indigo-900">
                      {formatDurasi(durasiLemburInput)} ({durasiLemburInput} menit)
                    </span>
                  </div>

                  <label className="block">
                    <span className="text-[12px] font-semibold text-slate-700">Alasan / Pekerjaan Lembur</span>
                    <input
                      value={lemburAlasan}
                      onChange={(e) => setLemburAlasan(e.target.value)}
                      placeholder="Contoh: Cetak spanduk pilkada pesanan kilat"
                      className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-white px-4 text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    />
                  </label>

                  <button
                    onClick={handleAjukanLembur}
                    className="w-full h-[56px] rounded-2xl bg-slate-900 text-white text-[14px] font-black tracking-wide shadow-lg active:scale-[0.98] transition"
                  >
                    Simpan Pengajuan Lembur
                  </button>

                  {todayRecord?.lemburMulai && (
                    <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-[12px] text-slate-600">
                      Lembur Anda hari ini: <span className="font-bold">{todayRecord.lemburMulai} - {todayRecord.lemburSelesai}</span> ({formatDurasi(hitungSelisihMenit(todayRecord.lemburMulai, todayRecord.lemburSelesai))})
                    </div>
                  )}
                </div>
              </div>

              <div>
                <h4 className="text-[13px] font-bold px-1">Daftar Lembur Tersimpan</h4>
                <div className="mt-3 space-y-3">
                  {overtimeList.map((r) => {
                    const dur = hitungSelisihMenit(r.lemburMulai, r.lemburSelesai);
                    return (
                      <div
                        key={r.id}
                        className="rounded-[20px] bg-white border border-slate-200 p-4 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-[12px] font-bold">{r.userName || 'Karyawan'} • {formatTanggalIndo(r.tanggal)}</p>
                          <p className="text-[11px] text-slate-500 mt-1">
                            {r.lemburMulai} - {r.lemburSelesai} ({formatDurasi(dur)}) • {r.lemburAlasan || 'Tanpa keterangan'}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="px-3 py-1.5 rounded-full bg-slate-900 text-white text-[12px] font-bold">
                            {formatDurasi(dur)}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {overtimeList.length === 0 && (
                    <p className="text-center text-[12px] text-slate-400 py-10">Belum ada catatan lembur</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: PROFIL (DATA DIRI KARYAWAN & ALAMAT LOKASI) */}
          {activeTab === 'profil' && (
            <div className="space-y-4 pt-1">
              
              {/* Form Data Diri Karyawan */}
              <div className="rounded-[28px] bg-white border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-full bg-gradient-to-br from-indigo-600 to-blue-500 grid place-items-center text-white text-[20px] font-black shadow-md">
                      {userProfile.namaLengkap ? userProfile.namaLengkap[0].toUpperCase() : 'K'}
                    </div>
                    <div>
                      <h3 className="text-[15px] font-bold text-slate-900">Data Diri Karyawan</h3>
                      <p className="text-[11px] text-slate-500">Lengkapi data diri untuk pencatatan absensi</p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3.5">
                  <label className="block">
                    <span className="text-[11px] font-bold text-slate-600">Nama Lengkap Karyawan *</span>
                    <input
                      value={userProfile.namaLengkap}
                      onChange={(e) => setUserProfile({ ...userProfile, namaLengkap: e.target.value })}
                      placeholder="Masukkan nama lengkap Anda..."
                      className="mt-1.5 w-full h-12 rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-[14px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] font-bold text-slate-600">NIK / ID Karyawan</span>
                      <input
                        value={userProfile.nik}
                        onChange={(e) => setUserProfile({ ...userProfile, nik: e.target.value })}
                        placeholder="Contoh: WGT-001"
                        className="mt-1.5 w-full h-12 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>

                    <label className="block">
                      <span className="text-[11px] font-bold text-slate-600">No. WhatsApp / HP</span>
                      <input
                        value={userProfile.noHp}
                        onChange={(e) => setUserProfile({ ...userProfile, noHp: e.target.value })}
                        placeholder="08xxxxxxxxxx"
                        className="mt-1.5 w-full h-12 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="text-[11px] font-bold text-slate-600">Bagian / Divisi Kerja</span>
                    <select
                      value={userProfile.jabatan}
                      onChange={(e) => setUserProfile({ ...userProfile, jabatan: e.target.value })}
                      className="mt-1.5 w-full h-12 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    >
                      {daftarJabatan.map((j) => (
                        <option key={j} value={j}>{j}</option>
                      ))}
                    </select>
                  </label>

                  {/* Pengaturan Alamat & Lokasi Karyawan */}
                  <div className="p-3.5 bg-indigo-50/70 border border-indigo-100 rounded-2xl">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-indigo-900">Alamat / Lokasi Kerja Karyawan</span>
                      <button
                        type="button"
                        onClick={handleDetectGPS}
                        className="text-[11px] font-black text-indigo-700 hover:text-indigo-900 flex items-center gap-1 bg-white px-2.5 py-1 rounded-full border border-indigo-200 shadow-sm active:scale-95 transition"
                      >
                        <span>📍 Deteksi GPS</span>
                      </button>
                    </div>

                    <input
                      value={userProfile.alamatLokasi}
                      onChange={(e) => setUserProfile({ ...userProfile, alamatLokasi: e.target.value })}
                      placeholder="Ketik alamat penempatan atau cabang kerja Anda..."
                      className="w-full h-11 rounded-xl border border-indigo-200 bg-white px-3 text-[12px] font-medium focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />

                    {/* Quick Location Pills */}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {lokasiPilihanDefault.map((lok) => (
                        <button
                          key={lok}
                          type="button"
                          onClick={() => setUserProfile({ ...userProfile, alamatLokasi: lok })}
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg border transition ${
                            userProfile.alamatLokasi === lok
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {lok.split('-')[0].trim()}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2">
                      Alamat ini akan otomatis dicatat sebagai lokasi absen masuk & pulang Anda.
                    </p>
                  </div>

                  <button
                    onClick={handleSaveProfile}
                    className="w-full h-12 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[13px] shadow-md active:scale-95 transition"
                  >
                    Simpan Data Diri ke Cloud
                  </button>
                </div>
              </div>

              {/* Status Role & Akun */}
              <div className="rounded-[24px] bg-white border border-slate-200 shadow-sm p-4">
                <p className="text-[12px] font-bold text-slate-900 mb-2">Status Akun & Hak Akses</p>
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] font-bold">
                      {isAdmin ? '👑 Akses Admin Aktif' : '👤 Akses Karyawan Biasa'}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {isAdmin ? 'Bisa lihat semua karyawan, ubah jam, & hapus data' : 'Hanya bisa melihat riwayat pribadi & tidak bisa menghapus'}
                    </p>
                  </div>
                  {isAdmin ? (
                    <button
                      onClick={handleAdminLogout}
                      className="px-3 py-1.5 rounded-full bg-rose-50 border border-rose-200 text-rose-600 font-bold text-[10px] active:scale-95 transition"
                    >
                      Keluar Admin
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowAdminLoginModal(true)}
                      className="px-3 py-1.5 rounded-full bg-slate-900 text-white font-bold text-[10px] active:scale-95 transition"
                    >
                      Login Admin
                    </button>
                  )}
                </div>

                {currentUser ? (
                  <div className="mt-3 flex items-center justify-between text-[11px] text-slate-600 pt-2 border-t border-slate-100">
                    <span>Google: {currentUser.email}</span>
                    <button
                      onClick={handleGoogleLogout}
                      className="text-rose-600 font-bold hover:underline"
                    >
                      Logout Google
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleGoogleLogin}
                    className="mt-3 w-full h-10 rounded-xl bg-slate-100 text-slate-700 font-bold text-[11px] flex items-center justify-center gap-2 hover:bg-slate-200 transition"
                  >
                    <span>Hubungkan dengan Akun Google</span>
                  </button>
                )}
              </div>

              {/* Menu Tambahan */}
              <div className="rounded-[24px] bg-white border border-slate-200 shadow-sm p-2">
                {[
                  {
                    label: '📲 Bagikan Aplikasi ke HP Karyawan',
                    sub: 'Kirim link WhatsApp & cara pasang di layar HP',
                    action: () => setShowShareModal(true),
                    highlight: true,
                  },
                  ...(isAdmin
                    ? [
                        {
                          label: '⚙️ Aturan Jam Kerja & Shift (Admin)',
                          sub: `${settings.jamMasuk} - ${settings.jamPulang} • Toleransi ${settings.toleransi}m`,
                          action: () => setShowSettingsModal(true),
                        },
                      ]
                    : []),
                  {
                    label: '📥 Export Rekapan CSV',
                    sub: 'Download file rekapan data absensi',
                    action: handleExportCSV,
                  },
                  {
                    label: '📋 Salin Ringkasan Teks',
                    sub: 'Format teks untuk WhatsApp pengurus kantor',
                    action: handleSalinLaporan,
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className={`w-full h-[60px] flex items-center justify-between px-4 rounded-2xl text-left active:scale-[0.99] transition ${
                      item.highlight ? 'bg-indigo-50/70 hover:bg-indigo-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div>
                      <p className={`text-[12px] font-bold ${item.highlight ? 'text-indigo-900' : 'text-slate-900'}`}>
                        {item.label}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{item.sub}</p>
                    </div>
                    <span className="h-7 w-7 rounded-full bg-slate-100 grid place-items-center text-[12px] text-slate-500">›</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* Bottom Tab Bar (Fixed 4 Tabs) */}
        <div className="absolute bottom-0 left-0 right-0 z-30">
          <div className="mx-auto max-w-[430px] bg-white/95 backdrop-blur-xl border-t border-slate-200 px-2 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.06)] rounded-t-[28px] md:rounded-b-[40px]">
            <div className="grid grid-cols-4 gap-1">
              {[
                { id: 'beranda', label: 'Beranda', icon: '⌂' },
                { id: 'riwayat', label: 'Riwayat', icon: '☰' },
                { id: 'lembur', label: 'Lembur', icon: '◷' },
                { id: 'profil', label: 'Profil Saya', icon: '◍' },
              ].map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`h-[56px] rounded-2xl flex flex-col items-center justify-center gap-1 transition-all active:scale-[0.95] touch-manipulation ${
                      isActive ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400 hover:text-slate-700'
                    }`}
                  >
                    <span className={`text-[18px] leading-none ${isActive ? 'scale-110' : ''}`}>{tab.icon}</span>
                    <span className="text-[10px] font-bold tracking-wide">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Modal Login Khusus Admin (user: admin / pass: admin) */}
        {showAdminLoginModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setShowAdminLoginModal(false)} />
            <div className="relative w-full max-w-[340px] rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 animate-[slideUp_0.32s_ease-out]">
              <div className="text-center">
                <div className="mx-auto h-12 w-12 rounded-2xl bg-amber-100 text-amber-600 grid place-items-center text-[22px] font-black shadow-inner">
                  👑
                </div>
                <h4 className="text-[16px] font-black text-slate-900 mt-3">Login Admin Wigata</h4>
                <p className="text-[11px] text-slate-500 mt-1">
                  Masukkan username & password admin, atau masuk lewat email <code>wigatadigitalprint@gmail.com</code>
                </p>
              </div>

              <form onSubmit={handleAdminLoginSubmit} className="mt-4 space-y-3">
                <label className="block">
                  <span className="text-[11px] font-bold text-slate-600">Username Admin</span>
                  <input
                    type="text"
                    value={adminUsername}
                    onChange={(e) => setAdminUsername(e.target.value)}
                    placeholder="Contoh: admin"
                    autoFocus
                    className="mt-1 w-full h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] font-semibold focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                </label>

                <label className="block">
                  <span className="text-[11px] font-bold text-slate-600">Password Admin</span>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Contoh: admin"
                    className="mt-1 w-full h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] font-semibold focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                </label>

                <div className="p-2.5 rounded-xl bg-amber-50 text-[10px] text-amber-800 border border-amber-200">
                  Default login: username <strong>admin</strong>, password <strong>admin</strong>
                </div>

                <div className="pt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAdminLoginModal(false)}
                    className="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-[12px]"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="flex-1 h-11 rounded-xl bg-slate-900 text-white font-bold text-[12px] shadow-md"
                  >
                    Masuk Admin
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Celebration Modal */}
        {celebrationModal && (
          <div className="absolute inset-0 z-40 grid place-items-center bg-slate-900/40 backdrop-blur-md p-6">
            <div className="w-full max-w-[300px] rounded-[32px] bg-white shadow-2xl p-6 text-center animate-[pop_0.4s_cubic-bezier(0.34,1.56,0.64,1)]">
              <div className="mx-auto h-20 w-20 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 grid place-items-center text-white text-[36px] shadow-lg shadow-emerald-200 animate-[bounce_0.6s]">
                ✓
              </div>
              <h3 className="mt-4 text-[18px] font-black">
                {celebrationModal.type === 'masuk' ? 'Absen Masuk Berhasil!' : 'Absen Pulang Berhasil!'}
              </h3>
              <p className="mt-1 text-[13px] text-slate-500">
                Pukul {celebrationModal.time} WIB • Tersinkron ke Cloud
              </p>
              <div className="mt-4 flex justify-center gap-1">
                {Array.from({ length: 8 }).map((_, idx) => (
                  <span
                    key={idx}
                    className="h-2 w-2 rounded-full animate-[confetti_0.8s_ease-out]"
                    style={{
                      background: ['#6366f1', '#3b82f6', '#f59e0b', '#10b981', '#ec4899'][idx % 5],
                      animationDelay: `${idx * 60}ms`,
                    }}
                  />
                ))}
              </div>
              <button
                onClick={() => setCelebrationModal(null)}
                className="mt-5 w-full h-12 rounded-full bg-slate-900 text-white font-bold text-[13px]"
              >
                Tutup & Lanjutkan
              </button>
            </div>
          </div>
        )}

        {/* Edit Attendance Record Modal (Admin Only) */}
        {editingRecord && (
          <div className="absolute inset-0 z-50 flex items-end md:items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setEditingRecord(null)} />
            <div className="relative w-full max-w-[430px] rounded-t-[28px] md:rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(16px+env(safe-area-inset-bottom))] animate-[slideUp_0.32s_ease-out]">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-200 mb-4 md:hidden" />
              <h4 className="text-[15px] font-bold">Edit Absensi: {editingRecord.userName || 'Karyawan'}</h4>
              <p className="text-[11px] text-slate-500">{formatTanggalIndo(editingRecord.tanggal)}</p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-600">Jam Masuk</span>
                  <input
                    type="time"
                    step={1}
                    value={editingRecord.masuk?.slice(0, 5) || ''}
                    onChange={(e) =>
                      setEditingRecord({
                        ...editingRecord,
                        masuk: e.target.value ? e.target.value + ':00' : null,
                      })
                    }
                    className="mt-2 w-full h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-[14px]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-600">Jam Pulang</span>
                  <input
                    type="time"
                    step={1}
                    value={editingRecord.pulang?.slice(0, 5) || ''}
                    onChange={(e) =>
                      setEditingRecord({
                        ...editingRecord,
                        pulang: e.target.value ? e.target.value + ':00' : null,
                      })
                    }
                    className="mt-2 w-full h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-[14px]"
                  />
                </label>
              </div>

              <label className="block mt-3">
                <span className="text-[11px] font-semibold text-slate-600">Lokasi Tercatat</span>
                <input
                  value={editingRecord.lokasiMasuk || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, lokasiMasuk: e.target.value })}
                  className="mt-1 w-full h-11 rounded-xl border border-slate-200 px-3 text-[12px]"
                />
              </label>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  onClick={() => setEditingRecord(null)}
                  className="h-12 rounded-full bg-slate-100 font-bold text-[13px]"
                >
                  Batal
                </button>
                <button
                  onClick={handleSaveEdit}
                  className="h-12 rounded-full bg-slate-900 text-white font-bold text-[13px]"
                >
                  Simpan Perubahan
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Modal (Shift Hours) */}
        {showSettingsModal && (
          <div className="absolute inset-0 z-50 flex items-end md:items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowSettingsModal(false)} />
            <div className="relative w-full max-w-[430px] rounded-t-[28px] md:rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(16px+env(safe-area-inset-bottom))] animate-[slideUp_0.32s_ease-out]">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-200 mb-4 md:hidden" />
              <h4 className="text-[15px] font-bold">Aturan Jam Kerja & Shift (Admin)</h4>
              <p className="text-[11px] text-slate-500 mt-1">
                Pengaturan jam kerja berlaku untuk penentuan status Hadir/Terlambat
              </p>

              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-[12px] font-semibold">Jam Masuk Normal</span>
                  <input
                    type="time"
                    value={settings.jamMasuk}
                    onChange={(e) => setSettings({ ...settings, jamMasuk: e.target.value })}
                    className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-mono font-bold"
                  />
                </label>

                <label className="block">
                  <span className="text-[12px] font-semibold">Jam Pulang Normal</span>
                  <input
                    type="time"
                    value={settings.jamPulang}
                    onChange={(e) => setSettings({ ...settings, jamPulang: e.target.value })}
                    className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-mono font-bold"
                  />
                </label>

                <label className="block">
                  <span className="text-[12px] font-semibold">Toleransi Keterlambatan (menit)</span>
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={settings.toleransi}
                    onChange={(e) => setSettings({ ...settings, toleransi: Number(e.target.value) || 0 })}
                    className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-bold"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    onClick={() =>
                      setSettings({
                        jamMasuk: '08:00',
                        jamPulang: '17:00',
                        toleransi: 15,
                        namaPerusahaan: NAMA_PERUSAHAAN_DEFAULT,
                      })
                    }
                    className="h-12 rounded-full bg-slate-100 font-bold text-[12px]"
                  >
                    Reset Default
                  </button>
                  <button
                    onClick={async () => {
                      setShowSettingsModal(false);
                      showToast('✓ Pengaturan shift disimpan');
                      if (currentUser) {
                        await saveSettingsToCloud(currentUser.uid, settings);
                      }
                    }}
                    className="h-12 rounded-full bg-slate-900 text-white font-bold text-[12px]"
                  >
                    Simpan ke Cloud
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Share To Employees Modal */}
        {showShareModal && (
          <div className="absolute inset-0 z-50 flex items-end md:items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowShareModal(false)} />
            <div className="relative w-full max-w-[430px] rounded-t-[28px] md:rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(16px+env(safe-area-inset-bottom))] max-h-[88dvh] overflow-y-auto animate-[slideUp_0.32s_ease-out]">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-200 mb-4 md:hidden" />
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-[16px] font-black text-slate-900">📲 Bagikan ke Karyawan</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Cara menjalankan di masing-masing HP karyawan
                  </p>
                </div>
                <button
                  onClick={() => setShowShareModal(false)}
                  className="h-8 w-8 rounded-full bg-slate-100 grid place-items-center text-slate-500 text-[14px] font-bold"
                >
                  ✕
                </button>
              </div>

              {/* URL Box */}
              <div className="mt-4 p-3.5 bg-slate-50 rounded-2xl border border-slate-200">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Tautan Aplikasi Absensi</p>
                <div className="mt-1 flex items-center justify-between gap-2 bg-white px-3 py-2 rounded-xl border border-slate-200">
                  <span className="text-[12px] font-mono text-slate-700 truncate max-w-[220px]">
                    {appShareUrl}
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(appShareUrl);
                      showToast('✓ Link berhasil disalin!');
                    }}
                    className="h-7 px-2.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold whitespace-nowrap active:scale-95 transition"
                  >
                    Salin
                  </button>
                </div>

                <a
                  href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                    `Halo rekan-rekan ${NAMA_PERUSAHAAN_DEFAULT}, silakan buka aplikasi absensi online kita di link ini untuk absen masuk dan pulang: ${appShareUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2.5 w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[12px] flex items-center justify-center gap-2 shadow-sm active:scale-95 transition"
                >
                  <span>💬 Kirim Tautan ke WhatsApp Karyawan</span>
                </a>
              </div>

              {/* Steps Guide for Employees */}
              <div className="mt-4 space-y-3">
                <p className="text-[12px] font-bold text-slate-800">Petunjuk untuk Karyawan:</p>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-indigo-50/50 border border-indigo-100">
                  <div className="h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    1
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-slate-800">Buka Link di HP Karyawan</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Buka tautan menggunakan browser Chrome (Android) atau Safari (iPhone).
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-indigo-50/50 border border-indigo-100">
                  <div className="h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    2
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-slate-800">Pasang Jadi Ikon Aplikasi di Layar HP</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      • <strong>Android (Chrome)</strong>: Klik titik tiga (⋮) kanan atas &gt; pilih <em>"Tambahkan ke Layar Utama" (Add to Home screen)</em>.<br />
                      • <strong>iPhone (Safari)</strong>: Klik tombol <em>Share (kotak panah ke atas)</em> &gt; pilih <em>"Add to Home Screen"</em>.<br />
                      Aplikasi akan otomatis terpasang di layar HP seperti aplikasi Play Store.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-indigo-50/50 border border-indigo-100">
                  <div className="h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    3
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-slate-800">Isi Data Diri & Alamat di Tab "Profil Saya"</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Karyawan mengisi Nama Lengkap, NIK, Divisi kerja, dan mengatur alamat/lokasi cabang kerja (bisa tekan 📍 Deteksi GPS).
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-emerald-50 border border-emerald-200">
                  <div className="h-6 w-6 rounded-full bg-emerald-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    4
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-emerald-900">Mulai Absen Masuk & Pulang</p>
                    <p className="text-[11px] text-emerald-800 mt-0.5">
                      Karyawan menekan tombol <strong>"ABSEN MASUK"</strong> saat tiba, dan <strong>"ABSEN PULANG"</strong> saat selesai. Data langsung tersimpan di cloud dan hanya Admin yang bisa mengedit/menghapus!
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-5">
                <button
                  onClick={() => setShowShareModal(false)}
                  className="w-full h-12 rounded-full bg-slate-900 text-white font-bold text-[13px] active:scale-95 transition"
                >
                  Tutup
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global Toast Message */}
        {toastMessage && (
          <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-50 rounded-full bg-slate-900 text-white px-5 py-2.5 text-[12px] font-bold shadow-xl border border-white/10 flex items-center gap-2 max-w-[90%] whitespace-nowrap">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span>{toastMessage}</span>
          </div>
        )}
      </div>

      <style>{`
        .scrollbar-none::-webkit-scrollbar { display: none; }
        .scrollbar-none { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes pop { 0% { transform: scale(0.85); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }
        @keyframes confetti { 0% { transform: translateY(0) } 50% { transform: translateY(-12px) } 100% { transform: translateY(0) } }
        @keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }
      `}</style>
    </div>
  );
}
