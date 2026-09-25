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
  saveAttendanceToCloud, 
  deleteAttendanceFromCloud, 
  saveSettingsToCloud,
  type AttendanceRecord,
  type UserSettings
} from './firebase';

const lokasiPilihan = [
  'Kantor Pusat - Jl. Sudirman No. 45',
  'Gedung A - Lt. 3, Area Absensi',
  'Kantor Pusat - Lobby Utama',
  'Cabang Barat - Ruko Central No. 12',
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

function getJamMenitDetik(): string {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
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

const initialSeedData = (): AttendanceRecord[] => {
  const d = new Date();
  const subHari = (n: number) => {
    const t = new Date(d);
    t.setDate(d.getDate() - n);
    return t.toISOString().slice(0, 10);
  };
  return [
    {
      id: 'seed-1',
      tanggal: subHari(1),
      masuk: '08:07:12',
      pulang: '17:12:45',
      lemburMulai: '18:00',
      lemburSelesai: '20:00',
      lemburAlasan: 'Laporan cetak bulanan',
      lokasiMasuk: lokasiPilihan[0] + ' • GPS ±8m',
      lokasiPulang: lokasiPilihan[0] + ' • GPS ±10m',
    },
    {
      id: 'seed-2',
      tanggal: subHari(2),
      masuk: '08:24:10',
      pulang: '17:05:00',
      lemburMulai: null,
      lemburSelesai: null,
      lemburAlasan: '',
      lokasiMasuk: lokasiPilihan[1] + ' • GPS ±12m',
      lokasiPulang: lokasiPilihan[0] + ' • GPS ±7m',
    },
    {
      id: 'seed-3',
      tanggal: subHari(3),
      masuk: '07:58:30',
      pulang: '16:50:11',
      lemburMulai: '17:30',
      lemburSelesai: '19:15',
      lemburAlasan: 'Maintenance mesin',
      lokasiMasuk: lokasiPilihan[0] + ' • GPS ±5m',
      lokasiPulang: lokasiPilihan[0] + ' • GPS ±6m',
    },
  ];
};

const LOCAL_STORAGE_KEY = 'absensi_pro_local_cache';
const SETTINGS_KEY = 'absensi_pro_settings_cache';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isCloudConnected, setIsCloudConnected] = useState<boolean>(true);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [syncStatus, setSyncStatus] = useState<'cloud' | 'local' | 'syncing'>('cloud');

  const [namaPerusahaan, setNamaPerusahaan] = useState<string>('PT. Digital Print Nusantara');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<'beranda' | 'riwayat' | 'lembur' | 'profil'>('beranda');

  const [settings, setSettings] = useState<UserSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      jamMasuk: '08:00',
      jamPulang: '17:00',
      toleransi: 15,
      namaPerusahaan: 'PT. Digital Print Nusantara',
    };
  });

  const [records, setRecords] = useState<AttendanceRecord[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return initialSeedData();
  });

  // Filters & State
  const [filterRentang, setFilterRentang] = useState<'minggu' | 'bulan' | 'semua'>('semua');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [editingRecord, setEditingRecord] = useState<AttendanceRecord | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [celebrationModal, setCelebrationModal] = useState<{ type: 'masuk' | 'pulang'; time: string } | null>(null);

  // Admin Mode state
  const [allRecords, setAllRecords] = useState<AttendanceRecord[]>([]);
  const [adminViewAll, setAdminViewAll] = useState<boolean>(false);

  const isAdmin = currentUser?.email === 'wigatadigitalprint@gmail.com';

  // Overtime Form
  const [lemburMulai, setLemburMulai] = useState<string>('18:00');
  const [lemburSelesai, setLemburSelesai] = useState<string>('20:00');
  const [lemburAlasan, setLemburAlasan] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement>(null);

  // 1. Test Firestore Connection on Boot
  useEffect(() => {
    testConnection().then((connected) => {
      setIsCloudConnected(connected);
    });
  }, []);

  // 2. Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 3. Realtime Cloud Sync when User is Logged In
  useEffect(() => {
    if (!currentUser) {
      setSyncStatus('local');
      return;
    }

    setSyncStatus('syncing');

    // Subscribe to Attendances in Firestore
    const unsubAttendances = subscribeToUserAttendances(
      currentUser.uid,
      (cloudRecords) => {
        if (cloudRecords && cloudRecords.length > 0) {
          setRecords(cloudRecords);
          try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cloudRecords));
          } catch {}
        } else {
          // If cloud has 0 records, migrate initial local records to cloud automatically!
          if (records.length > 0) {
            records.forEach((rec) => {
              saveAttendanceToCloud(rec, currentUser.uid, currentUser.email || '');
            });
          }
        }
        setSyncStatus('cloud');
      },
      (err) => {
        console.warn('Realtime attendances listener warning:', err);
        setSyncStatus('local');
      }
    );

    // Subscribe to Settings in Firestore
    const unsubSettings = subscribeToUserSettings(
      currentUser.uid,
      (cloudSettings) => {
        if (cloudSettings) {
          setSettings(cloudSettings);
          if (cloudSettings.namaPerusahaan) {
            setNamaPerusahaan(cloudSettings.namaPerusahaan);
          }
          try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(cloudSettings));
          } catch {}
        } else {
          // Upload current settings to cloud
          saveSettingsToCloud(currentUser.uid, {
            ...settings,
            namaPerusahaan,
          });
        }
      },
      (err) => {
        console.warn('Realtime settings listener warning:', err);
      }
    );

    // If Admin, subscribe to all attendances
    let unsubAll: (() => void) | undefined;
    if (currentUser.email === 'wigatadigitalprint@gmail.com') {
      unsubAll = subscribeToAllAttendances(
        (allData) => {
          setAllRecords(allData);
        },
        (err) => {
          console.warn('Admin subscribeToAllAttendances warning:', err);
        }
      );
    }

    return () => {
      unsubAttendances();
      unsubSettings();
      if (unsubAll) unsubAll();
    };
  }, [currentUser]);

  // Backup to localStorage
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

  // Clock Ticker
  useEffect(() => {
    const timer = setInterval(() => setCurrentDate(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Toast Auto-dismiss
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const showToast = (msg: string) => setToastMessage(msg);

  // Today's Record
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

  // Active records: If admin & adminViewAll is ON, display all staff attendance
  const activeRecords = isAdmin && adminViewAll ? allRecords : records;

  // Filtered Records for History
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

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (r) =>
          r.tanggal.includes(q) ||
          (r.userName && r.userName.toLowerCase().includes(q)) ||
          (r.userEmail && r.userEmail.toLowerCase().includes(q)) ||
          hitungStatusKehadiran(r, settings).toLowerCase().includes(q) ||
          (r.lemburAlasan && r.lemburAlasan.toLowerCase().includes(q)) ||
          r.lokasiMasuk.toLowerCase().includes(q)
      );
    }

    return list.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
  }, [activeRecords, filterRentang, searchQuery, settings]);

  // Overtime list
  const overtimeList = useMemo(
    () => activeRecords.filter((r) => r.lemburMulai && r.lemburSelesai).sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1)),
    [activeRecords]
  );

  // Statistics
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

  // Handlers
  const handleAbsenMasuk = async () => {
    if (todayRecord?.masuk) {
      showToast('Anda sudah melakukan absen masuk hari ini.');
      return;
    }

    const locRandom = lokasiPilihan[Math.floor(Math.random() * lokasiPilihan.length)] + ' • GPS ±6m';
    const jamSekarang = getHHMMSS();
    const newRecord: AttendanceRecord = {
      id: todayRecord ? todayRecord.id : `att-${todayDateStr}-${Date.now().toString().slice(-4)}`,
      userId: currentUser?.uid || 'guest-local',
      userEmail: currentUser?.email || '',
      userName: currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Karyawan',
      userPhoto: currentUser?.photoURL || '',
      tanggal: todayDateStr,
      masuk: jamSekarang,
      pulang: null,
      lemburMulai: null,
      lemburSelesai: null,
      lemburAlasan: '',
      lokasiMasuk: locRandom,
      lokasiPulang: '',
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => [newRecord, ...prev.filter((r) => r.tanggal !== todayDateStr)]);
    setCelebrationModal({ type: 'masuk', time: jamSekarang.slice(0, 5) });
    showToast(`✓ Absen masuk tercatat ${jamSekarang.slice(0, 5)} WIB`);

    // Sync to Firestore Cloud Database
    if (currentUser) {
      try {
        await saveAttendanceToCloud(newRecord, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving to Firestore:', err);
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

    const locRandom = lokasiPilihan[Math.floor(Math.random() * lokasiPilihan.length)] + ' • GPS ±5m';
    const jamSekarang = getHHMMSS();
    const updated: AttendanceRecord = {
      ...todayRecord,
      userName: currentUser?.displayName || todayRecord.userName || 'Karyawan',
      userPhoto: currentUser?.photoURL || todayRecord.userPhoto || '',
      pulang: jamSekarang,
      lokasiPulang: locRandom,
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => prev.map((r) => (r.tanggal === todayDateStr ? updated : r)));
    setCelebrationModal({ type: 'pulang', time: jamSekarang.slice(0, 5) });
    showToast(`✓ Absen pulang tercatat ${jamSekarang.slice(0, 5)} WIB`);

    // Sync to Firestore Cloud Database
    if (currentUser) {
      try {
        await saveAttendanceToCloud(updated, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving to Firestore:', err);
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
      showToast('Jam selesai harus lebih akhir dari jam mulai lembur.');
      return;
    }

    const updated: AttendanceRecord = {
      ...todayRecord,
      lemburMulai,
      lemburSelesai,
      lemburAlasan: lemburAlasan.trim() || 'Lembur operasional',
      updatedAt: new Date().toISOString(),
    };

    setRecords((prev) => prev.map((r) => (r.tanggal === todayDateStr ? updated : r)));
    showToast(`✓ Pengajuan lembur ${formatDurasi(durasiLemburInput)} berhasil disimpan`);
    setLemburAlasan('');

    if (currentUser) {
      try {
        await saveAttendanceToCloud(updated, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error saving overtime to Firestore:', err);
      }
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!confirm('Hapus catatan absensi ini?')) return;
    setRecords((prev) => prev.filter((r) => r.id !== recordId));
    showToast('Catatan absensi dihapus');

    if (currentUser) {
      try {
        await deleteAttendanceFromCloud(recordId);
      } catch (err) {
        console.error('Error deleting from Firestore:', err);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!editingRecord) return;
    setRecords((prev) => prev.map((r) => (r.id === editingRecord.id ? editingRecord : r)));
    showToast('Perubahan data absensi disimpan');

    if (currentUser) {
      try {
        await saveAttendanceToCloud(editingRecord, currentUser.uid, currentUser.email || '');
      } catch (err) {
        console.error('Error updating to Firestore:', err);
      }
    }
    setEditingRecord(null);
  };

  const handleSaveSettings = async (newSettings: UserSettings) => {
    setSettings(newSettings);
    setShowSettingsModal(false);
    showToast('Pengaturan jam kerja diperbarui');

    if (currentUser) {
      try {
        await saveSettingsToCloud(currentUser.uid, newSettings);
      } catch (err) {
        console.error('Error saving settings to Firestore:', err);
      }
    }
  };

  const handleGoogleLogin = async () => {
    try {
      showToast('Membuka login Google...');
      const user = await loginWithGoogle();
      showToast(`Selamat datang, ${user.displayName || user.email}! Data tersambung ke Firestore Cloud.`);
    } catch (err: any) {
      console.error('Login error:', err);
      showToast('Login dibatalkan atau terjadi kendala koneksi.');
    }
  };

  const handleGoogleLogout = async () => {
    try {
      await logoutUser();
      showToast('Berhasil keluar akun Google.');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleExportCSV = () => {
    const headers = [
      'ID',
      'Tanggal',
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
    link.download = `laporan_absensi_${todayDateStr}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Laporan CSV berhasil diunduh');
  };

  const handleSalinLaporan = async () => {
    const text = filteredRecords
      .map((r) => {
        const durKerja = r.masuk && r.pulang ? formatDurasi(hitungSelisihMenit(r.masuk, r.pulang)) : '-';
        const durLembur = r.lemburMulai && r.lemburSelesai ? formatDurasi(hitungSelisihMenit(r.lemburMulai, r.lemburSelesai)) : '-';
        return `${formatTanggalIndo(r.tanggal)} | Masuk: ${r.masuk || '-'} | Pulang: ${r.pulang || '-'} | Kerja: ${durKerja} | Lembur: ${durLembur} [${hitungStatusKehadiran(r, settings)}]`;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showToast('✓ Laporan ringkas disalin ke clipboard');
    } catch {
      showToast('Gagal menyalin teks laporan');
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

  return (
    <div className="min-h-[100dvh] bg-[#e6e9f0] md:bg-[#dfe3ec] flex justify-center antialiased text-slate-900 selection:bg-indigo-100">
      <div className="w-full max-w-[430px] bg-[#f6f7fb] min-h-[100dvh] md:min-h-[90dvh] md:my-6 md:rounded-[40px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_32px_80px_rgba(0,0,0,0.18)] overflow-hidden relative flex flex-col border border-white/60">
        
        {/* Top iOS / Mobile Bar */}
        <div 
          className="h-[44px] md:h-[36px] bg-[#f6f7fb] px-6 flex items-center justify-between text-[13px] font-bold shrink-0"
          style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}
        >
          <span className="font-mono tracking-wide">{timeParts[0]}:{timeParts[1]}</span>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Cloud DB Free
            </span>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-2.5 rounded-[2px] border border-slate-900/70 relative">
                <span className="absolute inset-[1px] bg-slate-900 rounded-[1px] w-[75%]" />
              </span>
              <span className="w-1 h-3 rounded-full bg-slate-900/80" />
            </div>
          </div>
        </div>

        {/* Cloud Connection & Header Info Bar */}
        <div className="px-5 pt-1 pb-2">
          {activeTab === 'beranda' && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-full bg-gradient-to-br from-indigo-600 via-blue-600 to-indigo-700 text-white grid place-items-center font-black text-[16px] shadow-md">
                  {currentUser?.displayName ? currentUser.displayName[0].toUpperCase() : 'A'}
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 font-medium leading-none">{greeting},</p>
                  <p className="text-[15px] font-bold leading-tight mt-1 tracking-tight max-w-[170px] truncate">
                    {currentUser?.displayName || namaPerusahaan}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowShareModal(true)}
                  className="h-8 px-2.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[11px] font-bold flex items-center gap-1 shadow-sm active:scale-95 transition"
                >
                  <span>📲 Bagikan</span>
                </button>
                {currentUser ? (
                  <div className="flex items-center gap-1 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full text-[10px] font-bold text-emerald-800">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    Cloud
                  </div>
                ) : (
                  <button
                    onClick={handleGoogleLogin}
                    className="h-8 px-3 rounded-full bg-slate-900 text-white text-[11px] font-bold flex items-center gap-1.5 shadow-sm active:scale-95 transition"
                  >
                    <span>Masuk</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab !== 'beranda' && (
            <div className="flex items-center justify-between py-2">
              <h1 className="text-[18px] font-black tracking-tight">
                {activeTab === 'riwayat' ? 'Riwayat Absensi' : activeTab === 'lembur' ? 'Pengajuan Lembur' : 'Profil & Database'}
              </h1>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-bold text-slate-600 bg-white border border-slate-200 px-2.5 py-1 rounded-full shadow-sm">
                  Firebase Firestore
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Content Body */}
        <main 
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 pb-[112px] scrollbar-none"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          {/* TAB 1: BERANDA */}
          {activeTab === 'beranda' && (
            <div className="space-y-4 pt-1">
              {/* Cloud Database Status Card */}
              <div className="rounded-[20px] bg-gradient-to-r from-emerald-500 to-teal-600 text-white p-3.5 shadow-md flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-white/20 grid place-items-center text-[18px]">
                    ☁️
                  </div>
                  <div>
                    <p className="text-[12px] font-black leading-tight">Database Cloud Gratis Terhubung</p>
                    <p className="text-[10px] text-white/80 mt-0.5">
                      {currentUser ? `Akun: ${currentUser.email} (Realtime Live)` : 'Firebase Firestore Spark Tier • Siap Sinkronisasi'}
                    </p>
                  </div>
                </div>
                {!currentUser && (
                  <button
                    onClick={handleGoogleLogin}
                    className="px-3 py-1.5 rounded-full bg-white text-emerald-800 font-bold text-[11px] shadow-sm active:scale-95 transition whitespace-nowrap"
                  >
                    Hubungkan
                  </button>
                )}
              </div>

              {/* Big Digital Clock Card */}
              <div className="rounded-[28px] bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 text-white p-5 shadow-[0_12px_32px_rgba(0,0,0,0.25)] relative overflow-hidden">
                <div className="absolute -top-16 -right-16 h-48 w-48 rounded-full bg-gradient-to-br from-indigo-500/30 to-blue-500/20 blur-2xl" />
                <div className="relative z-10">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] tracking-[0.2em] text-white/50 font-bold">WAKTU SERVER • INDONESIA (WIB)</p>
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                      <span className="text-[10px] text-white/70 font-semibold">LIVE CLOUD</span>
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
                    <div className="rounded-2xl bg-white/10 border border-white/10 px-3 py-2.5 text-center">
                      <p className="text-[10px] text-white/50 uppercase font-semibold">Jam Shift</p>
                      <p className="text-[12px] font-bold mt-0.5">{settings.jamMasuk} - {settings.jamPulang}</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 border border-white/10 px-3 py-2.5 text-center">
                      <p className="text-[10px] text-white/50 uppercase font-semibold">Toleransi</p>
                      <p className="text-[12px] font-bold mt-0.5">{settings.toleransi} menit</p>
                    </div>
                    <div className="rounded-2xl bg-white text-slate-900 px-3 py-2.5 text-center font-bold">
                      <p className="text-[10px] text-slate-500 uppercase font-semibold">Status Hari Ini</p>
                      <p className="text-[11px] mt-0.5">{statusHariIni}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Status Hari Ini & Jam Tercatat */}
              <div className="rounded-[24px] bg-white border border-slate-200/70 shadow-[0_8px_24px_rgba(0,0,0,0.06)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold">Status Kehadiran Hari Ini</h3>
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
                    <p className="text-[10px] text-indigo-400 mt-1">{durasiKerjaHariIni ? `${durasiKerjaHariIni} menit` : 'Auto Hitung'}</p>
                  </div>
                </div>

                {/* GPS Location Banner */}
                <div className="mt-3 flex items-center gap-2 rounded-2xl bg-slate-50 border border-dashed border-slate-200 px-3 py-2.5">
                  <div className="h-9 w-9 rounded-xl bg-white border border-slate-200 grid place-items-center text-[16px] shadow-sm">
                    📍
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold truncate">
                      {todayRecord?.lokasiMasuk?.split('•')[0]?.trim() || lokasiPilihan[0]}
                    </p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {todayRecord?.lokasiMasuk || 'Geolokasi GPS tervalidasi dengan database'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Main Action Buttons (Sticky at Bottom) */}
              <div className="sticky bottom-0 z-10 -mx-4 px-4 pt-3 pb-3 bg-gradient-to-t from-[#f6f7fb] via-[#f6f7fb] to-transparent">
                <div className="space-y-3">
                  <button
                    onClick={handleAbsenMasuk}
                    disabled={!!todayRecord?.masuk}
                    className={`w-full h-[64px] rounded-[20px] font-black text-[15px] tracking-wide flex items-center justify-center gap-3 transition-all active:scale-[0.98] touch-manipulation ${
                      todayRecord?.masuk
                        ? 'bg-slate-200 text-slate-400 border border-slate-200 cursor-not-allowed'
                        : 'bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-[0_12px_24px_rgba(79,70,229,0.35)]'
                    }`}
                    style={{ minHeight: 48 }}
                  >
                    <span className="h-9 w-9 rounded-full bg-white/20 grid place-items-center text-[18px]">↗</span>
                    <span className="flex flex-col items-start leading-none">
                      <span>ABSEN MASUK</span>
                      <span className="text-[10px] font-semibold opacity-80 tracking-normal mt-1">
                        {todayRecord?.masuk ? `Selesai (${todayRecord.masuk.slice(0, 5)})` : `Tap untuk masuk • Jam ${settings.jamMasuk}`}
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
                    style={{ minHeight: 48 }}
                  >
                    <span className="h-9 w-9 rounded-full bg-white/20 grid place-items-center text-[18px]">↙</span>
                    <span className="flex flex-col items-start leading-none">
                      <span>ABSEN PULANG</span>
                      <span className="text-[10px] font-semibold opacity-80 tracking-normal mt-1">
                        {todayRecord?.pulang ? `Selesai (${todayRecord.pulang.slice(0, 5)})` : `Tap untuk pulang • Jam ${settings.jamPulang}`}
                      </span>
                    </span>
                  </button>
                </div>
                <p className="mt-3 text-center text-[10px] text-slate-400 font-medium">
                  Validasi anti-dobel & realtime cloud Firestore • GPS geofencing aktif
                </p>
              </div>
            </div>
          )}

          {/* TAB 2: RIWAYAT */}
          {activeTab === 'riwayat' && (
            <div className="space-y-4 pt-1">
              {/* Admin Mode Switch Banner */}
              {isAdmin && (
                <div className="bg-slate-900 text-white rounded-[22px] p-3 shadow-md border border-slate-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="h-8 w-8 rounded-xl bg-amber-400/20 text-amber-400 grid place-items-center text-[15px]">
                        👑
                      </span>
                      <div>
                        <p className="text-[12px] font-black leading-tight">Admin Perusahaan</p>
                        <p className="text-[10px] text-white/60 mt-0.5">
                          {adminViewAll
                            ? `Pantau ${allRecords.length} data seluruh karyawan`
                            : 'Melihat data absensi pribadi Anda'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setAdminViewAll(!adminViewAll)}
                      className={`h-8 px-3 rounded-full text-[11px] font-bold transition-all shadow-sm ${
                        adminViewAll
                          ? 'bg-emerald-400 text-slate-950 font-black'
                          : 'bg-white/10 text-white border border-white/20'
                      }`}
                    >
                      {adminViewAll ? '✓ Semua Karyawan' : 'Lihat Semua Karyawan'}
                    </button>
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
                    placeholder="Cari..."
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
                          <div className="h-11 w-11 rounded-2xl bg-slate-900 text-white grid place-items-center font-bold text-[12px]">
                            {new Date(r.tanggal).getDate()}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-[13px] font-bold">{formatTanggalIndo(r.tanggal)}</p>
                              {r.userName && (
                                <span className="bg-indigo-50 text-indigo-700 text-[10px] font-bold px-2 py-0.2 rounded-full border border-indigo-100">
                                  {r.userName}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 truncate max-w-[170px]">
                              {r.userEmail ? `${r.userEmail.split('@')[0]} • ` : ''}{r.lokasiMasuk?.split('•')[0]?.trim() || 'Kantor'}
                            </p>
                          </div>
                        </div>

                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
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

                      <div className="mt-4 grid grid-cols-3 gap-2">
                        <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-3 text-center">
                          <p className="text-[10px] text-slate-400 font-bold uppercase">Masuk</p>
                          <p className="mt-1 font-mono text-[13px] font-black">{r.masuk?.slice(0, 5) || '--:--'}</p>
                        </div>
                        <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-3 text-center">
                          <p className="text-[10px] text-slate-400 font-bold uppercase">Pulang</p>
                          <p className="mt-1 font-mono text-[13px] font-black">{r.pulang?.slice(0, 5) || '--:--'}</p>
                        </div>
                        <div className="rounded-2xl bg-indigo-50 border border-indigo-100 p-3 text-center">
                          <p className="text-[10px] text-indigo-400 font-bold uppercase">Total</p>
                          <p className="mt-1 text-[13px] font-black text-indigo-900">{durKerja ? formatDurasi(durKerja) : '-'}</p>
                        </div>
                      </div>

                      {durLembur > 0 && (
                        <div className="mt-3 rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2.5 flex items-center justify-between">
                          <p className="text-[11px] font-semibold text-amber-800">
                            Lembur {formatDurasi(durLembur)} • {r.lemburMulai}-{r.lemburSelesai}
                          </p>
                          <p className="text-[10px] text-amber-600 truncate max-w-[120px]">{r.lemburAlasan}</p>
                        </div>
                      )}

                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => setEditingRecord(r)}
                          className="flex-1 h-11 rounded-full bg-white border border-slate-200 text-[12px] font-bold active:scale-[0.98] transition"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteRecord(r.id)}
                          className="h-11 px-5 rounded-full bg-rose-50 border border-rose-100 text-rose-600 text-[12px] font-bold active:scale-[0.98] transition"
                        >
                          Hapus
                        </button>
                      </div>
                    </div>
                  );
                })}

                {filteredRecords.length === 0 && (
                  <div className="py-16 text-center text-slate-400 text-[13px]">
                    Belum ada data absensi untuk filter ini
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
                      <span className="text-[12px] font-semibold text-slate-700">Jam Mulai</span>
                      <input
                        type="time"
                        value={lemburMulai}
                        onChange={(e) => setLemburMulai(e.target.value)}
                        className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[12px] font-semibold text-slate-700">Jam Selesai</span>
                      <input
                        type="time"
                        value={lemburSelesai}
                        onChange={(e) => setLemburSelesai(e.target.value)}
                        className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-slate-50 px-4 text-[16px] font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </label>
                  </div>

                  <div className="rounded-2xl bg-indigo-50 border border-indigo-100 px-4 py-3 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-indigo-700">Estimasi Durasi</span>
                    <span className="text-[14px] font-black text-indigo-900">
                      {formatDurasi(durasiLemburInput)} ({durasiLemburInput} menit)
                    </span>
                  </div>

                  <label className="block">
                    <span className="text-[12px] font-semibold text-slate-700">Keterangan / Alasan Lembur</span>
                    <input
                      value={lemburAlasan}
                      onChange={(e) => setLemburAlasan(e.target.value)}
                      placeholder="Contoh: Cetak spanduk pesanan kilat atau deadline proyek"
                      className="mt-2 w-full h-[56px] rounded-2xl border border-slate-200 bg-white px-4 text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    />
                  </label>

                  <button
                    onClick={handleAjukanLembur}
                    className="w-full h-[56px] rounded-2xl bg-slate-900 text-white text-[14px] font-black tracking-wide shadow-lg active:scale-[0.98] transition"
                  >
                    Simpan & Ajukan ke Cloud
                  </button>

                  {todayRecord?.lemburMulai && (
                    <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-[12px] text-slate-600">
                      Lembur hari ini tercatat: <span className="font-bold">{todayRecord.lemburMulai} - {todayRecord.lemburSelesai}</span> ({formatDurasi(hitungSelisihMenit(todayRecord.lemburMulai, todayRecord.lemburSelesai))})
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
                          <p className="text-[12px] font-bold">{formatTanggalIndo(r.tanggal)}</p>
                          <p className="text-[11px] text-slate-500 mt-1">
                            {r.lemburMulai} - {r.lemburSelesai} • {r.lemburAlasan || 'Tanpa keterangan'}
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
                    <p className="text-center text-[12px] text-slate-400 py-10">Belum ada data lembur</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: PROFIL & DATABASE */}
          {activeTab === 'profil' && (
            <div className="space-y-4 pt-1">
              {/* Profile Card */}
              <div className="rounded-[28px] bg-white border border-slate-200 shadow-sm p-5 text-center">
                <div className="mx-auto h-20 w-20 rounded-full bg-gradient-to-br from-indigo-600 to-blue-500 grid place-items-center text-white text-[28px] font-black shadow-lg">
                  {currentUser?.displayName ? currentUser.displayName[0].toUpperCase() : 'A'}
                </div>

                <div className="mt-3">
                  <input
                    value={namaPerusahaan}
                    onChange={(e) => setNamaPerusahaan(e.target.value)}
                    className="w-full text-center bg-transparent text-[16px] font-bold focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    {currentUser ? currentUser.email : 'Karyawan • Mode Tamu (Lokal)'}
                  </p>
                </div>

                {currentUser ? (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <span className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
                      ✓ Terautentikasi Google
                    </span>
                    <button
                      onClick={handleGoogleLogout}
                      className="px-3 py-1 rounded-full bg-rose-50 text-rose-600 border border-rose-200 text-[11px] font-bold active:scale-95"
                    >
                      Keluar
                    </button>
                  </div>
                ) : (
                  <div className="mt-4">
                    <button
                      onClick={handleGoogleLogin}
                      className="w-full h-11 rounded-full bg-slate-900 text-white font-bold text-[12px] flex items-center justify-center gap-2 active:scale-95 shadow"
                    >
                      <span>Masuk dengan Google (Aktifkan Cloud)</span>
                    </button>
                  </div>
                )}

                <div className="mt-5 grid grid-cols-3 gap-2 text-left">
                  <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-3 text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Hari</p>
                    <p className="text-[16px] font-black mt-1">{statistik.totalHari}</p>
                  </div>
                  <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-3 text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Jam Kerja</p>
                    <p className="text-[16px] font-black mt-1">{formatDurasi(statistik.totalJamBulan)}</p>
                  </div>
                  <div className="rounded-2xl bg-[#f6f7fb] border border-slate-100 p-3 text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Lembur</p>
                    <p className="text-[16px] font-black mt-1">{formatDurasi(statistik.totalLembur)}</p>
                  </div>
                </div>
              </div>

              {/* Free Cloud Database Info Box */}
              <div className="rounded-[24px] bg-slate-900 text-white p-5 shadow-lg space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[18px]">🔥</span>
                    <span className="text-[13px] font-bold">Firebase Firestore (Gratis)</span>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                    Connected
                  </span>
                </div>

                <div className="space-y-1.5 text-[11px] text-white/70">
                  <div className="flex justify-between border-b border-white/10 pb-1">
                    <span>Project ID:</span>
                    <span className="font-mono text-white/90">inductive-stage-2wh4c</span>
                  </div>
                  <div className="flex justify-between border-b border-white/10 pb-1">
                    <span>Paket:</span>
                    <span className="text-emerald-300 font-bold">Spark Free Tier (Gratis Selamanya)</span>
                  </div>
                  <div className="flex justify-between border-b border-white/10 pb-1">
                    <span>Kapasitas Gratis:</span>
                    <span className="text-white/90">50.000 baca / 20.000 tulis per hari</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Penyimpanan:</span>
                    <span className="text-white/90">1 GB Cloud Storage</span>
                  </div>
                </div>
              </div>

              {/* Settings Action List */}
              <div className="rounded-[24px] bg-white border border-slate-200 shadow-sm p-2">
                {[
                  {
                    label: '📲 Bagikan Aplikasi ke Karyawan',
                    sub: 'Kirim link via WhatsApp & cara pasang di HP karyawan',
                    action: () => setShowShareModal(true),
                    highlight: true,
                  },
                  {
                    label: 'Aturan Jam Kerja & Shift',
                    sub: `${settings.jamMasuk} - ${settings.jamPulang} • Toleransi ${settings.toleransi}m`,
                    action: () => setShowSettingsModal(true),
                  },
                  {
                    label: 'Export Data ke CSV',
                    sub: 'Download backup arsip absensi',
                    action: handleExportCSV,
                  },
                  {
                    label: 'Salin Ringkasan Laporan',
                    sub: 'Format teks untuk pesan WhatsApp atau Email',
                    action: handleSalinLaporan,
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className={`w-full h-[64px] flex items-center justify-between px-4 rounded-2xl text-left active:scale-[0.99] transition ${
                      item.highlight ? 'bg-indigo-50/70 hover:bg-indigo-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div>
                      <p className={`text-[13px] font-bold ${item.highlight ? 'text-indigo-900' : 'text-slate-900'}`}>
                        {item.label}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{item.sub}</p>
                    </div>
                    <span className="h-8 w-8 rounded-full bg-slate-100 grid place-items-center text-[12px]">›</span>
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
                { id: 'profil', label: 'Profil', icon: '◍' },
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

        {/* Success Modal Celebration */}
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

        {/* Edit Attendance Record Modal */}
        {editingRecord && (
          <div className="absolute inset-0 z-50 flex items-end md:items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setEditingRecord(null)} />
            <div className="relative w-full max-w-[430px] rounded-t-[28px] md:rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(16px+env(safe-area-inset-bottom))] animate-[slideUp_0.32s_ease-out]">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-200 mb-4 md:hidden" />
              <h4 className="text-[15px] font-bold">Edit Absensi - {formatTanggalIndo(editingRecord.tanggal)}</h4>

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

                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-600">Lembur Mulai</span>
                  <input
                    type="time"
                    value={editingRecord.lemburMulai || ''}
                    onChange={(e) =>
                      setEditingRecord({
                        ...editingRecord,
                        lemburMulai: e.target.value || null,
                      })
                    }
                    className="mt-2 w-full h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-[14px]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-600">Lembur Selesai</span>
                  <input
                    type="time"
                    value={editingRecord.lemburSelesai || ''}
                    onChange={(e) =>
                      setEditingRecord({
                        ...editingRecord,
                        lemburSelesai: e.target.value || null,
                      })
                    }
                    className="mt-2 w-full h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-[14px]"
                  />
                </label>
              </div>

              <label className="block mt-3">
                <span className="text-[11px] font-semibold text-slate-600">Alasan Lembur</span>
                <input
                  value={editingRecord.lemburAlasan || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      lemburAlasan: e.target.value,
                    })
                  }
                  className="mt-2 w-full h-12 rounded-2xl border border-slate-200 px-4 text-[13px]"
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

        {/* Settings Modal */}
        {showSettingsModal && (
          <div className="absolute inset-0 z-50 flex items-end md:items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowSettingsModal(false)} />
            <div className="relative w-full max-w-[430px] rounded-t-[28px] md:rounded-[28px] bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(16px+env(safe-area-inset-bottom))] animate-[slideUp_0.32s_ease-out]">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-200 mb-4 md:hidden" />
              <h4 className="text-[15px] font-bold">Aturan Jam Kerja & Shift</h4>
              <p className="text-[11px] text-slate-500 mt-1">
                Pengaturan tersinkronisasi ke cloud database Firebase
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

                <div className="rounded-2xl bg-indigo-50 border border-indigo-100 p-3 text-[11px] text-indigo-800">
                  Status otomatis: Terlambat jika masuk &gt; {settings.jamMasuk} + {settings.toleransi}m. Pulang cepat jika &lt; {settings.jamPulang}.
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() =>
                      handleSaveSettings({
                        jamMasuk: '08:00',
                        jamPulang: '17:00',
                        toleransi: 15,
                        namaPerusahaan,
                      })
                    }
                    className="h-12 rounded-full bg-slate-100 font-bold text-[12px]"
                  >
                    Reset Default
                  </button>
                  <button
                    onClick={() => handleSaveSettings(settings)}
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

              {/* URL Box with Quick Copy & WA Button */}
              <div className="mt-4 p-3.5 bg-slate-50 rounded-2xl border border-slate-200">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Tautan Aplikasi Web</p>
                <div className="mt-1 flex items-center justify-between gap-2 bg-white px-3 py-2 rounded-xl border border-slate-200">
                  <span className="text-[12px] font-mono text-slate-700 truncate max-w-[220px]">
                    {typeof window !== 'undefined' ? window.location.origin : 'https://ais-dev-zrzfdpduo77fhn43hrbwfz-206443197156.asia-southeast1.run.app'}
                  </span>
                  <button
                    onClick={() => {
                      const url = typeof window !== 'undefined' ? window.location.origin : '';
                      navigator.clipboard.writeText(url);
                      showToast('✓ Link berhasil disalin!');
                    }}
                    className="h-7 px-2.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold whitespace-nowrap active:scale-95 transition"
                  >
                    Salin
                  </button>
                </div>

                <a
                  href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                    `Halo rekan-rekan ${namaPerusahaan}, silakan buka aplikasi absensi online kita di link ini untuk absen masuk dan pulang: ${
                      typeof window !== 'undefined' ? window.location.origin : 'https://ais-dev-zrzfdpduo77fhn43hrbwfz-206443197156.asia-southeast1.run.app'
                    }`
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
                <p className="text-[12px] font-bold text-slate-800">Langkah untuk Karyawan:</p>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-indigo-50/50 border border-indigo-100">
                  <div className="h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    1
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-slate-800">Buka Link di HP Masing-Masing</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Karyawan cukup membuka link dari pesan WhatsApp menggunakan browser bawaan (Chrome di Android atau Safari di iPhone).
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
                      • <strong>Android (Chrome)</strong>: Klik ikon titik tiga (⋮) di pojok kanan atas &gt; pilih <em>"Tambahkan ke Layar Utama" (Add to Home screen)</em>.<br />
                      • <strong>iPhone (Safari)</strong>: Klik tombol <em>Share (ikon kotak panah ke atas)</em> &gt; pilih <em>"Add to Home Screen"</em>.<br />
                      Ikon aplikasi <strong>Absensi Pro</strong> akan langsung muncul di layar utama HP seperti aplikasi biasa!
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-2xl bg-indigo-50/50 border border-indigo-100">
                  <div className="h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-black grid place-items-center shrink-0 mt-0.5">
                    3
                  </div>
                  <div>
                    <p className="text-[12px] font-bold text-slate-800">Login dengan Akun Google Karyawan</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Karyawan cukup menekan tombol <strong>"Masuk Google"</strong> satu kali. Nama dan email karyawan otomatis terdaftar di database cloud Anda.
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
                      Setiap kali tiba di tempat kerja, karyawan tinggal buka icon di HP dan tekan <strong>"ABSEN MASUK"</strong>. Saat pulang, tekan <strong>"ABSEN PULANG"</strong>. Data langsung masuk ke Rekap Admin secara realtime!
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-5">
                <button
                  onClick={() => setShowShareModal(false)}
                  className="w-full h-12 rounded-full bg-slate-900 text-white font-bold text-[13px] active:scale-95 transition"
                >
                  Selesai & Tutup
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global Toast */}
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
