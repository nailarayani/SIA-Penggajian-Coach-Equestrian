const notice = document.querySelector("#notice");
const coachForm = document.querySelector("#coach-form");
const attendanceForm = document.querySelector("#attendance-form");
const payrollForm = document.querySelector("#payroll-form");
const adminNotice = document.querySelector("#admin-notice");
const periodForm = document.querySelector("#period-form");
const accountFilter = document.querySelector("#account-filter");
const adminMoneyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});

const SUPABASE_URL = "https://wqelfmcsmwgvevacmkdj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_rrKuMXLm_nHBs7lZJLNxIw_dsvpcju4";
const REPORT_ACCOUNTS = [
  { code: "1000", name: "Kas", category: "asset", normal_balance: "debit" },
  { code: "2100", name: "Utang Honor Coach", category: "liability", normal_balance: "credit" },
  { code: "2200", name: "Utang Potongan Honor", category: "liability", normal_balance: "credit" },
  { code: "3100", name: "Modal dan Saldo Laba", category: "equity", normal_balance: "credit" },
  { code: "4100", name: "Pendapatan Jasa", category: "revenue", normal_balance: "credit" },
  { code: "5100", name: "Beban Honor Coach", category: "expense", normal_balance: "debit" }
];

let reportData = null;

const moneyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});

function showNotice(message, isSuccess) {
  notice.textContent = message;
  notice.classList.toggle("success", isSuccess);
  notice.hidden = false;
  window.clearTimeout(showNotice.timeoutId);
  showNotice.timeoutId = window.setTimeout(() => {
    notice.hidden = true;
  }, 6000);
}

async function api(resource, options = {}) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
      ...options,
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(options.headers || {})
      }
    });
  } catch {
    throw new Error("Tidak dapat menghubungi Supabase. Periksa koneksi internet dan konfigurasi project.");
  }

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Supabase belum memberi akses publik. Jalankan seluruh backend/schema.sql di SQL Editor Supabase, lalu muat ulang halaman.");
    }
    throw new Error(result && (result.message || result.details || result.hint) || "Permintaan ke Supabase tidak berhasil.");
  }
  return result;
}

async function apiAll(resource) {
  const pageSize = 500;
  const maxRows = 100000;
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await api(resource, {
      headers: { Range: `${offset}-${offset + pageSize - 1}`, "Range-Unit": "items" }
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error("Jumlah data terlalu besar untuk dimuat sekaligus.");
}

function parsePayrollPeriod(period) {
  const [start, end] = String(period || "").split("|");
  return { start, end: end || start };
}

function mapPayroll(record) {
  const period = parsePayrollPeriod(record.periode_gaji);
  const payments = record.pembayaran || [];
  const lastPayment = [...payments].sort((a, b) =>
    b.tanggal_pembayaran.localeCompare(a.tanggal_pembayaran)
  )[0];
  return {
    ...record,
    id: record.id_penggajian,
    period_start: period.start,
    period_end: period.end,
    total_sesi: Number(record.total_sesi),
    total_honor: Number(record.total_honor),
    potongan: Number(record.potongan),
    net_amount: Number(record.gaji_bersih),
    status: record.status_penggajian === "Dibayar" ? "paid" : "draft",
    paid_at: lastPayment ? `${lastPayment.tanggal_pembayaran}T00:00:00Z` : null,
    coaches: record.coach ? { full_name: record.coach.nama_coach } : null
  };
}

function buildJournalLines(payrollRecords, paymentRecords, endDate) {
  const accountsByCode = new Map(REPORT_ACCOUNTS.map((account) => [account.code, account]));
  const lines = [];
  const addEntry = (entryId, entryNumber, entryDate, description, sourceType, sourceId, rows) => {
    if (!entryDate || entryDate > endDate) return;
    rows.forEach((row, index) => {
      lines.push({
        id: `${entryId}-${index + 1}`,
        account_code: row.account_code,
        debit: row.debit,
        credit: row.credit,
        description: row.description,
        accounts: accountsByCode.get(row.account_code),
        journal_entries: {
          id: entryId,
          entry_no: entryNumber,
          entry_date: entryDate,
          description,
          source_type: sourceType,
          source_id: sourceId
        }
      });
    });
  };

  payrollRecords.forEach((payroll) => {
    const { start, end } = parsePayrollPeriod(payroll.periode_gaji);
    const gross = Number(payroll.total_honor);
    const net = Number(payroll.gaji_bersih);
    const deduction = Number(payroll.potongan);
    if (gross <= 0) return;
    const rows = [
      { account_code: "5100", description: "Beban honor coach", debit: gross, credit: 0 },
      { account_code: "2100", description: "Utang honor coach setelah potongan", debit: 0, credit: net }
    ];
    if (deduction > 0) {
      rows.push({ account_code: "2200", description: "Utang potongan honor", debit: 0, credit: deduction });
    }
    addEntry(
      `accrual-${payroll.id_penggajian}`,
      `JU-${String(payroll.id_penggajian).padStart(8, "0")}`,
      end,
      `Pengakuan honor coach periode ${start} s.d. ${end}`,
      "payroll_accrual",
      payroll.id_penggajian,
      rows
    );
  });

  paymentRecords.forEach((payment) => {
    const amount = Number(payment.jumlah_pembayaran);
    if (amount <= 0) return;
    addEntry(
      `payment-${payment.id_pembayaran}`,
      `BYR-${String(payment.id_pembayaran).padStart(8, "0")}`,
      payment.tanggal_pembayaran,
      `Pembayaran honor coach · ${payment.metode_pembayaran}`,
      "payroll_payment",
      payment.id_penggajian,
      [
        { account_code: "2100", description: "Pelunasan utang honor coach", debit: amount, credit: 0 },
        { account_code: "1000", description: "Kas keluar untuk pembayaran honor", debit: 0, credit: amount }
      ]
    );
  });

  return lines;
}

function addCell(row, value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

function setRows(target, message, columnCount) {
  target.replaceChildren();
  const row = document.createElement("tr");
  const cell = addCell(row, message, "empty");
  cell.colSpan = columnCount;
  target.append(row);
}

function fillCoachOptions(coaches) {
  document.querySelectorAll('select[name="id_coach"]').forEach((select) => {
    const previousValue = select.value;
    select.replaceChildren(new Option("Pilih coach", ""));
    coaches.forEach((coach) => select.add(new Option(coach.nama_coach, coach.id_coach)));
    if (coaches.some((coach) => coach.id_coach === previousValue)) select.value = previousValue;
  });
}

function renderAttendance(attendance) {
  const target = document.querySelector("#attendance-rows");
  target.replaceChildren();
  if (attendance.length === 0) {
    setRows(target, "Belum ada jadwal mengajar.", 5);
    return;
  }

  attendance.forEach((item) => {
    const row = document.createElement("tr");
    addCell(row, item.coach ? item.coach.nama_coach : "—");
    addCell(row, formatDate(item.tanggal_mengajar));
    addCell(row, String(item.jam_mengajar).slice(0, 5));
    addCell(row, String(item.jumlah_sesi));
    const statusCell = addCell(row, "");
    if (item.status_kehadiran === "Dijadwalkan") {
      const completeButton = document.createElement("button");
      completeButton.className = "row-action";
      completeButton.type = "button";
      completeButton.textContent = "Tandai selesai";
      completeButton.addEventListener("click", () => completeSession(item.id_jadwal, completeButton));
      statusCell.append(completeButton);
    } else {
      const status = document.createElement("span");
      status.className = `status ${item.status_kehadiran === "Hadir" ? "status-paid" : "status-draft"}`;
      status.textContent = item.status_kehadiran;
      statusCell.append(status);
    }
    target.append(row);
  });
}

function renderPayrolls(payrolls) {
  const target = document.querySelector("#payroll-rows");
  target.replaceChildren();
  if (payrolls.length === 0) {
    setRows(target, "Belum ada penggajian.", 4);
    return;
  }

  payrolls.forEach((payroll) => {
    const row = document.createElement("tr");
    const coachCell = addCell(row, "");
    const coachName = document.createElement("span");
    coachName.className = "pay-name";
    coachName.textContent = payroll.coaches ? payroll.coaches.full_name : "—";
    const period = document.createElement("span");
    period.className = "pay-period";
    period.textContent = `${formatDate(payroll.period_start)} – ${formatDate(payroll.period_end)}`;
    coachCell.append(coachName, period);
    addCell(row, moneyFormatter.format(Number(payroll.net_amount)), "money");

    const statusCell = addCell(row, "");
    const status = document.createElement("span");
    status.className = `status status-${payroll.status}`;
    status.textContent = payroll.status === "paid" ? "Dibayar" : "Draft";
    statusCell.append(status);

    const actionCell = addCell(row, "");
    if (payroll.status === "draft") {
      const button = document.createElement("button");
      button.className = "row-action";
      button.type = "button";
      button.textContent = "Tandai dibayar";
      button.addEventListener("click", () => markPaid(payroll.id, button));
      actionCell.append(button);
    } else {
      actionCell.textContent = payroll.paid_at
        ? new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(payroll.paid_at))
        : "—";
    }

    const detailsRow = document.createElement("tr");
    const detailsCell = addCell(detailsRow, "");
    detailsCell.colSpan = 4;
    const details = document.createElement("details");
    details.className = "detail-list";
    const summary = document.createElement("summary");
    summary.textContent = `${Number(payroll.total_sesi)} sesi · Lihat rincian`;
    const gross = document.createElement("div");
    gross.textContent = `Total honor: ${moneyFormatter.format(Number(payroll.total_honor))}`;
    const deduction = document.createElement("div");
    deduction.textContent = `Potongan: ${moneyFormatter.format(Number(payroll.potongan))}`;
    const net = document.createElement("div");
    net.textContent = `Gaji bersih: ${moneyFormatter.format(Number(payroll.net_amount))}`;
    details.append(summary, gross, deduction, net);
    detailsCell.append(details);
    target.append(row, detailsRow);
  });
}

async function loadData() {
  const [coaches, attendance, payrollRecords] = await Promise.all([
    apiAll("coach?select=id_coach,nama_coach,alamat,no_telepon,tarif_per_sesi&order=nama_coach.asc"),
    apiAll("jadwal_mengajar?select=id_jadwal,id_coach,tanggal_mengajar,jam_mengajar,jumlah_sesi,status_kehadiran,coach(nama_coach)&order=tanggal_mengajar.desc,jam_mengajar.desc"),
    apiAll("penggajian?select=id_penggajian,id_coach,periode_gaji,total_sesi,total_honor,potongan,gaji_bersih,status_penggajian,coach(nama_coach),pembayaran(id_pembayaran,tanggal_pembayaran,jumlah_pembayaran,metode_pembayaran,keterangan)&order=periode_gaji.desc")
  ]);
  const payrolls = payrollRecords.map(mapPayroll);
  fillCoachOptions(coaches);
  document.querySelector("#coach-count").textContent = coaches.length;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString().slice(0, 10);
  const monthAttendance = attendance.filter((item) =>
    item.tanggal_mengajar >= monthStart && item.status_kehadiran === "Hadir"
  );
  document.querySelector("#attendance-count").textContent = monthAttendance.reduce(
    (total, item) => total + Number(item.jumlah_sesi), 0
  );
  document.querySelector("#payroll-count").textContent = payrolls.length;
  renderAttendance(attendance);
  renderPayrolls(payrolls);
}

async function submitForm(form, resource, successMessage) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    if (form === coachForm) payload.tarif_per_sesi = Number(payload.tarif_per_sesi);
    if (form === attendanceForm) payload.jumlah_sesi = Number(payload.jumlah_sesi);
    if (form === payrollForm) {
      payload.p_coach_id = payload.id_coach;
      payload.p_period_start = payload.period_start;
      payload.p_period_end = payload.period_end;
      payload.p_potongan = Number(payload.potongan);
      delete payload.id_coach;
      delete payload.period_start;
      delete payload.period_end;
      delete payload.potongan;
    }
    await api(resource, { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    if (form === attendanceForm) setAttendanceDateToToday();
    showNotice(successMessage, true);
    await loadData();
  } catch (error) {
    showNotice(error.message, false);
  } finally {
    button.disabled = false;
  }
}

async function markPaid(id, button) {
  button.disabled = true;
  try {
    await api("rpc/create_payroll_payment", {
      method: "POST",
      body: JSON.stringify({
        p_payroll_id: id,
        p_payment_date: new Date().toISOString().slice(0, 10),
        p_payment_method: "Transfer bank",
        p_payment_note: "Pembayaran honor coach"
      })
    });
    showNotice("Penggajian berhasil ditandai sebagai dibayar.", true);
    await loadData();
  } catch (error) {
    showNotice(error.message, false);
    button.disabled = false;
  }
}

async function completeSession(id, button) {
  button.disabled = true;
  try {
    const updated = await api(`jadwal_mengajar?id_jadwal=eq.${encodeURIComponent(id)}&status_kehadiran=eq.Dijadwalkan`, {
      method: "PATCH",
      body: JSON.stringify({ status_kehadiran: "Hadir" })
    });
    if (!Array.isArray(updated) || updated.length === 0) {
      throw new Error("Jadwal tidak ditemukan atau status kehadirannya sudah berubah.");
    }
    showNotice("Sesi selesai dan sekarang dapat dihitung dalam penggajian.", true);
    await loadData();
  } catch (error) {
    showNotice(error.message, false);
    button.disabled = false;
  }
}

coachForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(coachForm, "coach", "Data coach berhasil disimpan.");
});

attendanceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(attendanceForm, "jadwal_mengajar", "Jadwal mengajar berhasil disimpan.");
});

payrollForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const start = payrollForm.elements.period_start.value;
  const end = payrollForm.elements.period_end.value;
  if (start > end) {
    showNotice("Tanggal awal periode tidak boleh melewati tanggal akhir.", false);
    return;
  }
  submitForm(payrollForm, "rpc/create_payroll", "Penggajian berhasil dibuat.");
});

function setAttendanceDateToToday() {
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  attendanceForm.elements.tanggal_mengajar.value = today.toISOString().slice(0, 10);
}

function showAdminNotice(message, isSuccess) {
  adminNotice.textContent = message;
  adminNotice.classList.toggle("success", isSuccess);
  adminNotice.hidden = false;
}

function localDate(date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 10);
}

function formatReportDate(value) {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function createReportCell(row, value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function setReportEmpty(target, message, columns) {
  target.replaceChildren();
  const row = document.createElement("tr");
  const cell = createReportCell(row, message, "empty");
  cell.colSpan = columns;
  target.append(row);
}

function reportAmountCell(row, value, kind) {
  return createReportCell(row, adminMoneyFormatter.format(Number(value) || 0), `amount ${kind || ""}`);
}

function writeStatementLine(target, label, value, total) {
  const row = document.createElement("div");
  row.className = `statement-line${total ? " total" : ""}`;
  const name = document.createElement("span");
  name.textContent = label;
  const amount = document.createElement("strong");
  amount.textContent = adminMoneyFormatter.format(value);
  row.append(name, amount);
  target.append(row);
}

function getReportRange() {
  return { start: periodForm.elements.start.value, end: periodForm.elements.end.value };
}

function getSortedJournalLines() {
  return [...reportData.journal_lines].sort((a, b) => {
    const left = a.journal_entries;
    const right = b.journal_entries;
    return left.entry_date.localeCompare(right.entry_date)
      || left.entry_no.localeCompare(right.entry_no)
      || a.id.localeCompare(b.id);
  });
}

function renderAdminSummary() {
  const payrolls = reportData.payrolls;
  const paid = payrolls.filter((payroll) => payroll.status === "paid");
  const unpaid = payrolls.filter((payroll) => payroll.status !== "paid");
  const sum = (items, field) => items.reduce((total, item) => total + Number(item[field]), 0);
  document.querySelector("#summary-count").textContent = payrolls.length;
  document.querySelector("#summary-total").textContent = adminMoneyFormatter.format(sum(payrolls, "total_honor"));
  document.querySelector("#summary-paid").textContent = adminMoneyFormatter.format(sum(paid, "net_amount"));
  document.querySelector("#summary-unpaid").textContent = adminMoneyFormatter.format(sum(unpaid, "net_amount"));
  document.querySelector("#summary-paid-count").textContent = `${paid.length} periode dibayar`;
  document.querySelector("#summary-unpaid-count").textContent = `${unpaid.length} periode belum dibayar`;
}

function renderAdminPayrolls() {
  const target = document.querySelector("#admin-payroll-rows");
  target.replaceChildren();
  if (reportData.payrolls.length === 0) {
    setReportEmpty(target, "Tidak ada penggajian pada rentang periode ini.", 6);
    return;
  }
  reportData.payrolls.forEach((payroll) => {
    const row = document.createElement("tr");
    const coachCell = createReportCell(row, "");
    const coachName = document.createElement("span");
    coachName.className = "primary-cell";
    coachName.textContent = payroll.coaches ? payroll.coaches.full_name : "—";
    const coachHours = document.createElement("span");
    coachHours.className = "sub-cell";
    coachHours.textContent = `${Number(payroll.total_sesi)} sesi`;
    coachCell.append(coachName, coachHours);
    createReportCell(row, `${formatReportDate(payroll.period_start)} – ${formatReportDate(payroll.period_end)}`);
    createReportCell(row, `${Number(payroll.total_sesi)} sesi`);
    reportAmountCell(row, payroll.total_honor);
    const statusCell = createReportCell(row, "");
    const status = document.createElement("span");
    status.className = `status status-${payroll.status}`;
    status.textContent = payroll.status === "paid" ? "Dibayar" : "Belum dibayar";
    statusCell.append(status);
    createReportCell(row, payroll.paid_at ? formatReportDate(payroll.paid_at) : "—");
    target.append(row);
  });
}

function renderJournals() {
  const target = document.querySelector("#journal-rows");
  target.replaceChildren();
  const { start, end } = getReportRange();
  const lines = getSortedJournalLines().filter((line) => {
    const date = line.journal_entries.entry_date;
    return date >= start && date <= end;
  });
  if (lines.length === 0) {
    setReportEmpty(target, "Belum ada jurnal pada periode ini. Proses penggajian untuk membuat jurnal otomatis.", 5);
    return;
  }
  lines.forEach((line) => {
    const entry = line.journal_entries;
    const row = document.createElement("tr");
    const ref = createReportCell(row, "");
    const entryNumber = document.createElement("span");
    entryNumber.className = "primary-cell";
    entryNumber.textContent = entry.entry_no;
    const entryDate = document.createElement("span");
    entryDate.className = "sub-cell";
    entryDate.textContent = formatReportDate(entry.entry_date);
    ref.append(entryNumber, entryDate);
    createReportCell(row, `${line.account_code} · ${line.accounts.name}`);
    createReportCell(row, line.description || entry.description);
    reportAmountCell(row, line.debit, "debit");
    reportAmountCell(row, line.credit, "credit");
    target.append(row);
  });
}

function getAccountBalance(lines, accountCode, throughDate, beforeDate) {
  return lines.reduce((balance, line) => {
    if (line.account_code !== accountCode) return balance;
    const date = line.journal_entries.entry_date;
    if (date > throughDate || (beforeDate && date >= beforeDate)) return balance;
    return balance + Number(line.debit) - Number(line.credit);
  }, 0);
}

function renderLedger() {
  const target = document.querySelector("#ledger-rows");
  target.replaceChildren();
  const { start, end } = getReportRange();
  const selectedAccount = accountFilter.value;
  const lines = getSortedJournalLines().filter((line) => selectedAccount === "" || line.account_code === selectedAccount);
  const throughEnd = lines.filter((line) => line.journal_entries.entry_date <= end);
  if (throughEnd.length === 0) {
    setReportEmpty(target, "Belum ada mutasi akun sampai tanggal akhir periode.", 6);
    return;
  }
  const balances = new Map();
  reportData.accounts.forEach((account) => {
    balances.set(account.code, getAccountBalance(lines, account.code, start, start));
  });
  const visible = throughEnd.filter((line) => line.journal_entries.entry_date >= start);
  if (visible.length === 0) {
    setReportEmpty(target, "Tidak ada mutasi pada rentang periode yang dipilih.", 6);
    return;
  }
  visible.forEach((line) => {
    const previous = balances.get(line.account_code) || 0;
    const next = previous + Number(line.debit) - Number(line.credit);
    balances.set(line.account_code, next);
    const row = document.createElement("tr");
    createReportCell(row, formatReportDate(line.journal_entries.entry_date));
    createReportCell(row, `${line.account_code} · ${line.accounts.name}`);
    createReportCell(row, `${line.journal_entries.entry_no} · ${line.journal_entries.description}`);
    reportAmountCell(row, line.debit, "debit");
    reportAmountCell(row, line.credit, "credit");
    const balanceCell = reportAmountCell(row, Math.abs(next), next >= 0 ? "debit" : "credit");
    balanceCell.textContent = `${adminMoneyFormatter.format(Math.abs(next))} ${next >= 0 ? "D" : "K"}`;
    target.append(row);
  });
}

function renderTrialBalance() {
  const target = document.querySelector("#trial-rows");
  const footer = document.querySelector("#trial-total");
  target.replaceChildren();
  footer.replaceChildren();
  const { end } = getReportRange();
  const lines = getSortedJournalLines().filter((line) => line.journal_entries.entry_date <= end);
  let debitTotal = 0;
  let creditTotal = 0;
  reportData.accounts.forEach((account) => {
    const debit = lines.filter((line) => line.account_code === account.code)
      .reduce((total, line) => total + Number(line.debit), 0);
    const credit = lines.filter((line) => line.account_code === account.code)
      .reduce((total, line) => total + Number(line.credit), 0);
    const rawBalance = debit - credit;
    const debitBalance = Math.max(rawBalance, 0);
    const creditBalance = Math.max(-rawBalance, 0);
    debitTotal += debitBalance;
    creditTotal += creditBalance;
    const row = document.createElement("tr");
    createReportCell(row, account.code);
    createReportCell(row, account.name);
    createReportCell(row, account.category);
    reportAmountCell(row, debitBalance, "debit");
    reportAmountCell(row, creditBalance, "credit");
    target.append(row);
  });
  const row = document.createElement("tr");
  const label = createReportCell(row, "Total saldo");
  label.colSpan = 3;
  reportAmountCell(row, debitTotal, "debit");
  reportAmountCell(row, creditTotal, "credit");
  footer.append(row);
}

function getAccountBalancesThrough(endDate, startDate) {
  const lines = getSortedJournalLines().filter((line) => line.journal_entries.entry_date <= endDate);
  const balances = new Map(reportData.accounts.map((account) => [account.code, {
    account,
    debit: 0,
    credit: 0,
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 0,
    periodCredit: 0
  }]));
  lines.forEach((line) => {
    const item = balances.get(line.account_code);
    if (!item) return;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    item.debit += debit;
    item.credit += credit;
    if (line.journal_entries.entry_date < startDate) {
      item.openingDebit += debit;
      item.openingCredit += credit;
    } else {
      item.periodDebit += debit;
      item.periodCredit += credit;
    }
  });
  return balances;
}

function renderFinancialStatements() {
  const { start, end } = getReportRange();
  const balances = getAccountBalancesThrough(end, start);
  const get = (code) => balances.get(code);
  const revenue = [...balances.values()].filter((item) => item.account.category === "revenue")
    .reduce((total, item) => total + item.periodCredit - item.periodDebit, 0);
  const expenses = [...balances.values()].filter((item) => item.account.category === "expense")
    .reduce((total, item) => total + item.periodDebit - item.periodCredit, 0);
  const netIncome = revenue - expenses;
  const incomeTarget = document.querySelector("#income-rows");
  incomeTarget.replaceChildren();
  document.querySelector("#income-period").textContent = `${formatReportDate(start)} – ${formatReportDate(end)}`;
  writeStatementLine(incomeTarget, "Pendapatan jasa", revenue);
  writeStatementLine(incomeTarget, "Beban honor coach", expenses);
  writeStatementLine(incomeTarget, "Laba (rugi) bersih", netIncome, true);

  const cash = get("1000");
  const cashTarget = document.querySelector("#cash-rows");
  cashTarget.replaceChildren();
  document.querySelector("#cash-period").textContent = `${formatReportDate(start)} – ${formatReportDate(end)} · metode langsung`;
  const openingCash = cash ? cash.openingDebit - cash.openingCredit : 0;
  const cashIn = cash ? cash.periodDebit : 0;
  const cashOut = cash ? cash.periodCredit : 0;
  writeStatementLine(cashTarget, "Saldo kas awal", openingCash);
  writeStatementLine(cashTarget, "Kas masuk", cashIn);
  writeStatementLine(cashTarget, "Kas keluar · honor", cashOut);
  writeStatementLine(cashTarget, "Saldo kas akhir", openingCash + cashIn - cashOut, true);

  const positionTarget = document.querySelector("#position-rows");
  positionTarget.replaceChildren();
  document.querySelector("#position-period").textContent = `Per posisi ${formatReportDate(end)}`;
  const cashEnd = cash ? cash.debit - cash.credit : 0;
  const payable = get("2100");
  const deductionPayable = get("2200");
  const liabilities = (payable ? payable.credit - payable.debit : 0)
    + (deductionPayable ? deductionPayable.credit - deductionPayable.debit : 0);
  const capital = get("3100");
  const equity = (capital ? capital.credit - capital.debit : 0)
    + [...balances.values()].filter((item) => ["revenue", "expense"].includes(item.account.category))
      .reduce((total, item) => total + item.credit - item.debit, 0);
  writeStatementLine(positionTarget, "Aset · Kas", cashEnd);
  writeStatementLine(positionTarget, "Liabilitas · utang honor dan potongan", liabilities);
  writeStatementLine(positionTarget, "Ekuitas · modal dan laba ditahan", equity);
  writeStatementLine(positionTarget, "Total liabilitas dan ekuitas", liabilities + equity, true);
}

function renderAdminReports() {
  renderAdminSummary();
  renderAdminPayrolls();
  renderJournals();
  renderLedger();
  renderTrialBalance();
  renderFinancialStatements();
}

async function loadReport() {
  const button = periodForm.querySelector("button");
  button.disabled = true;
  try {
    const { start, end } = getReportRange();
    if (!start || !end || start > end) throw new Error("Rentang tanggal laporan tidak valid.");
    const [allPayrolls, payments] = await Promise.all([
      apiAll("penggajian?select=id_penggajian,id_coach,periode_gaji,total_sesi,total_honor,potongan,gaji_bersih,status_penggajian,coach(nama_coach),pembayaran(id_pembayaran,tanggal_pembayaran,jumlah_pembayaran,metode_pembayaran,keterangan)&order=periode_gaji.asc"),
      apiAll(`pembayaran?select=id_pembayaran,id_penggajian,tanggal_pembayaran,jumlah_pembayaran,metode_pembayaran,keterangan&tanggal_pembayaran=lte.${encodeURIComponent(end)}&order=tanggal_pembayaran.asc`)
    ]);
    reportData = {
      accounts: REPORT_ACCOUNTS,
      payrolls: allPayrolls
        .filter((record) => {
          const period = parsePayrollPeriod(record.periode_gaji);
          return period.start <= end && period.end >= start;
        })
        .map(mapPayroll),
      journal_lines: buildJournalLines(allPayrolls, payments, end),
      start,
      end
    };
    const selected = accountFilter.value;
    accountFilter.replaceChildren(new Option("Semua akun", ""));
    reportData.accounts.forEach((account) => {
      accountFilter.add(new Option(`${account.code} · ${account.name}`, account.code));
    });
    if (reportData.accounts.some((account) => account.code === selected)) accountFilter.value = selected;
    renderAdminReports();
    adminNotice.hidden = true;
  } catch (error) {
    showAdminNotice(error.message, false);
  } finally {
    button.disabled = false;
  }
}

function isAdminRoute() {
  return window.location.hash === "#admin"
    || ["#payroll", "#journal", "#ledger", "#trial-balance", "#statements"].includes(window.location.hash);
}

let lastAdminView = false;

function setActiveView() {
  const adminActive = isAdminRoute();
  document.querySelector("#home-view").hidden = adminActive;
  document.querySelector("#admin-view").hidden = !adminActive;
  document.querySelector("#home-nav").hidden = !adminActive;
  document.querySelector("#admin-nav").hidden = adminActive;
  if (adminActive) {
    const targetId = window.location.hash.slice(1);
    if (targetId !== "admin") {
      window.requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView());
    }
    if (!lastAdminView || !reportData || adminNotice.hidden === false) loadReport();
  }
  lastAdminView = adminActive;
}

periodForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadReport();
});

accountFilter.addEventListener("change", renderLedger);
window.addEventListener("hashchange", setActiveView);

const now = new Date();
periodForm.elements.start.value = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
periodForm.elements.end.value = localDate(now);
setAttendanceDateToToday();
loadData().catch((error) => {
  showNotice(error.message, false);
  setRows(document.querySelector("#attendance-rows"), "Data tidak dapat dimuat.", 5);
  setRows(document.querySelector("#payroll-rows"), "Data tidak dapat dimuat.", 4);
});
setActiveView();
