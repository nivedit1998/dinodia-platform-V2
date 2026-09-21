// Architecture: App Router surface src/app/employeemanagement/EmployeeManagementClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Role } from '@prisma/client';
import { CompanyPortalShell } from '@/components/companyPortal/CompanyPortalShell';
import { parseApiError } from '@/lib/authClientError';
import { COMPANY_PORTAL_ROLE_LABELS, type CompanyPortalRole } from '@/lib/companyPortalAccess';
import type { CompanyEmployeeRecord } from '@/lib/companyEmployees';

type EmployeesResponse =
  | { ok: true; employees: CompanyEmployeeRecord[] }
  | { ok?: false; error?: string };

type SaveResponse =
  | { ok: true; employee: CompanyEmployeeRecord; temporaryPassword?: string }
  | { ok?: false; error?: string; employee?: CompanyEmployeeRecord };

const ROLE_OPTIONS = [
  Role.INSTALLER,
  Role.SENIOR_OPERATIONS_MANAGER,
  Role.SENIOR_CUSTOMER_SUPPORT,
  Role.CXO,
] as const;

type FormState = {
  username: string;
  email: string;
  phoneNumber: string;
  temporaryPassword: string;
  role: CompanyPortalRole;
};

const EMPTY_FORM: FormState = {
  username: '',
  email: '',
  phoneNumber: '',
  temporaryPassword: '',
  role: Role.INSTALLER,
};

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function EmployeeManagementClient({
  username,
  role,
}: {
  username: string;
  role: CompanyPortalRole;
}) {
  const [employees, setEmployees] = useState<CompanyEmployeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const activeCxos = useMemo(
    () => employees.filter((employee) => employee.role === Role.CXO && employee.isActive),
    [employees]
  );

  async function loadEmployees() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/company/employees', { cache: 'no-store' });
      const data: EmployeesResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
      if (!res.ok || !data.ok) {
        const parsed = parseApiError(data, 'Unable to load employees.');
        throw new Error(parsed.message);
      }
      setEmployees(data.employees);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load employees.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEmployees();
  }, []);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMessage(null);
    setError(null);
  }

  function startEdit(employee: CompanyEmployeeRecord) {
    setEditingId(employee.id);
    setForm({
      username: employee.username,
      email: employee.email ?? '',
      phoneNumber: employee.phoneNumber ?? '',
      temporaryPassword: '',
      role: employee.role,
    });
    setMessage(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!form.username || !form.email || !form.phoneNumber || !form.role) {
      setError('Fill in username, email, phone number, and role.');
      return;
    }
    if (!editingId && form.temporaryPassword.length < 8) {
      setError('Temporary password must be at least 8 characters.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/company/employees/${editingId}` : '/api/company/employees', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          phoneNumber: form.phoneNumber,
          role: form.role,
          ...(editingId ? {} : { temporaryPassword: form.temporaryPassword }),
        }),
      });
      const data: SaveResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
      if (!res.ok || !data.ok) {
        const parsed = parseApiError(data, 'Unable to save employee.');
        throw new Error(parsed.message);
      }
      setMessage(
        editingId
          ? `Updated ${data.employee.username}.`
          : `Created ${data.employee.username}. Temporary password was emailed to ${data.employee.email}.`
      );
      if (data.temporaryPassword) {
        setMessage((prev) => `${prev ?? ''} Temporary password: ${data.temporaryPassword}`.trim());
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save employee.');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword(employee: CompanyEmployeeRecord) {
    const confirmed = window.confirm(`Reset ${employee.username}'s password and email a new temporary password?`);
    if (!confirmed) return;
    setResettingId(employee.id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/company/employees/${employee.id}/reset-password`, { method: 'POST' });
      const data: SaveResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
      if (!res.ok || !data.ok) {
        const parsed = parseApiError(data, 'Unable to reset password.');
        throw new Error(parsed.message);
      }
      setMessage(`Password reset email sent to ${data.employee.email}. Temporary password: ${data.temporaryPassword}`);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setResettingId(null);
    }
  }

  async function handleToggleActive(employee: CompanyEmployeeRecord) {
    const nextState = !employee.isActive;
    const confirmed = window.confirm(
      `${nextState ? 'Activate' : 'Deactivate'} ${employee.username}? ${employee.role === Role.CXO && !nextState ? 'This cannot remove the last active CXO.' : ''}`
    );
    if (!confirmed) return;
    setTogglingId(employee.id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/company/employees/${employee.id}/toggle-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextState }),
      });
      const data: SaveResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
      if (!res.ok || !data.ok) {
        const parsed = parseApiError(data, 'Unable to update employee status.');
        throw new Error(parsed.message);
      }
      setMessage(`${data.employee.username} is now ${data.employee.isActive ? 'active' : 'inactive'}.`);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update employee status.');
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <CompanyPortalShell username={username} role={role}>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Employee management</p>
            <h2 className="mt-1 text-3xl font-semibold text-slate-900">Create and manage company users</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              CXO users can create installers and staff accounts, issue temporary passwords, reset access, and
              deactivate users when needed.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-slate-500">Active CXOs</p>
            <p className="text-2xl font-semibold text-slate-900">{activeCxos.length}</p>
          </div>
        </div>

        {error ? (
          <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
        ) : null}
        {message ? (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{editingId ? 'Edit employee' : 'Create employee'}</h3>
                <p className="text-sm text-slate-600">
                  {editingId ? 'Update the user details below.' : 'Temporary password is emailed to the new employee.'}
                </p>
              </div>
              {editingId ? (
                <button
                  type="button"
                  onClick={startCreate}
                  className="rounded-full border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel edit
                </button>
              ) : null}
            </div>

            <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
              <div>
                <label className="block text-sm font-medium text-slate-700">Username</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  value={form.username}
                  onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  value={form.email}
                  onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Phone number</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  value={form.phoneNumber}
                  onChange={(e) => setForm((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                  placeholder="+44..."
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Role</label>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  value={form.role}
                  onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value as CompanyPortalRole }))}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {COMPANY_PORTAL_ROLE_LABELS[option]}
                    </option>
                  ))}
                </select>
              </div>
              {!editingId ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700">Temporary password</label>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    value={form.temporaryPassword}
                    onChange={(e) => setForm((prev) => ({ ...prev, temporaryPassword: e.target.value }))}
                    required
                    minLength={8}
                  />
                  <p className="mt-1 text-xs text-slate-500">The employee changes this on first login.</p>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Password changes are handled separately with the reset password action.
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {saving ? 'Saving…' : editingId ? 'Update employee' : 'Create employee'}
              </button>
            </form>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Employees</h3>
                <p className="text-sm text-slate-600">All internal company accounts in one place.</p>
              </div>
              <button
                type="button"
                onClick={() => void loadEmployees()}
                className="rounded-full border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Refresh
              </button>
            </div>

            {loading ? (
              <p className="mt-6 text-sm text-slate-600">Loading employees…</p>
            ) : employees.length === 0 ? (
              <p className="mt-6 text-sm text-slate-600">No employees found.</p>
            ) : (
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Username</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Phone</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Updated</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {employees.map((employee) => (
                      <tr key={employee.id} className="align-top">
                        <td className="px-3 py-3 font-medium text-slate-900">{employee.username}</td>
                        <td className="px-3 py-3 text-slate-700">{employee.email ?? '—'}</td>
                        <td className="px-3 py-3 text-slate-700">{employee.phoneNumber ?? '—'}</td>
                        <td className="px-3 py-3 text-slate-700">{COMPANY_PORTAL_ROLE_LABELS[employee.role]}</td>
                        <td className="px-3 py-3">
                          <span
                            className={[
                              'rounded-full px-2.5 py-1 text-xs font-semibold',
                              employee.isActive
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-slate-100 text-slate-600',
                            ].join(' ')}
                          >
                            {employee.isActive ? 'Active' : 'Inactive'}
                          </span>
                          {employee.mustChangePassword ? (
                            <p className="mt-1 text-xs text-amber-700">Temporary password pending</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-slate-600">{formatDate(employee.updatedAt)}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => startEdit(employee)}
                              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleResetPassword(employee)}
                              disabled={resettingId === employee.id}
                              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                            >
                              {resettingId === employee.id ? 'Resetting…' : 'Reset password'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleActive(employee)}
                              disabled={togglingId === employee.id}
                              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                            >
                              {togglingId === employee.id
                                ? 'Saving…'
                                : employee.isActive
                                  ? 'Deactivate'
                                  : 'Activate'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </CompanyPortalShell>
  );
}
