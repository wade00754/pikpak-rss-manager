import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { api, setCSRF } from '../lib/api.js';
import { errorMessage, isCancelled } from '../lib/i18n.js';
import { storageSummary } from '../lib/storage.js';
import type { AppSettings, Session, Status } from '../lib/types.js';
import { DirtyForm } from './DirtyForm.js';
import { CheckboxField, Feedback, FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { usePreferences } from './Preferences.js';
import { SettingsLayout } from './SettingsLayout.js';
import { TokenForm } from './TokenForm.js';

export function Settings({
    status,
    onRefresh,
    onAuthenticated,
}: {
    status: Status;
    onRefresh: () => Promise<void>;
    onAuthenticated: () => Promise<void>;
}): JSX.Element {
    const { t } = usePreferences();
    const [section, setSection] = useState('pikpak');
    const connected = status.connected && !status.paused;
    const storage = storageSummary(status);
    return (
        <section className='utility-view' id='view-settings'>
            <SettingsLayout
                id='settings'
                onChange={setSection}
                sections={[
                    { id: 'pikpak', label: 'PikPak 授權' },
                    { id: 'site', label: '網站設定' },
                    { id: 'password', label: '修改密碼' },
                ]}
                value={section}
            >
                <article
                    aria-labelledby='settings-nav-pikpak'
                    className={`settings-panel${section === 'pikpak' ? '' : ' hidden'}`}
                    id='settings-pikpak'
                >
                    <div className='panel-heading'>
                        <h2>{t('PikPak 授權')}</h2>
                        <span
                            className={`badge ${connected ? 'green' : 'warning'}`}
                            id='settings-badge'
                        >
                            {t(
                                connected
                                    ? '連線正常'
                                    : status.paused
                                      ? '已暫停'
                                      : '未綁定'
                            )}
                        </span>
                    </div>
                    {status.connected && (
                        <div className='account-card'>
                            <span className='account-avatar'>P</span>
                            <div>
                                <strong>
                                    {status.name || t('PikPak 帳號')}
                                </strong>
                                {storage && (
                                    <span>
                                        {storage.capacity} {t('雲端空間')}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                    {!connected && (
                        <Feedback
                            message={t(
                                status.message || '請重新檢查 PikPak 連線。'
                            )}
                            status
                        />
                    )}
                    <TokenForm
                        onCheck={async () => {
                            await api('/api/settings/pikpak/check', 'POST', {});
                            await onRefresh();
                        }}
                        onSaved={onRefresh}
                    />
                </article>
                <article
                    aria-labelledby='settings-nav-site'
                    className={`settings-panel${section === 'site' ? '' : ' hidden'}`}
                    id='settings-site'
                >
                    <div className='panel-heading'>
                        <h2>{t('網站設定')}</h2>
                    </div>
                    <SiteSettings />
                </article>
                <article
                    aria-labelledby='settings-nav-password'
                    className={`settings-panel${section === 'password' ? '' : ' hidden'}`}
                    id='settings-password'
                >
                    <div className='panel-heading'>
                        <h2>{t('修改密碼')}</h2>
                    </div>
                    <PasswordSettings onAuthenticated={onAuthenticated} />
                </article>
            </SettingsLayout>
        </section>
    );
}
function SiteSettings(): JSX.Element {
    const { t } = usePreferences();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [saved, setSaved] = useState(false);
    const [baseline, setBaseline] = useState<AppSettings | null>(null);
    const [values, setValues] = useState<AppSettings | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        void api<AppSettings>(
            '/api/settings/app',
            'GET',
            undefined,
            controller.signal
        )
            .then((value) => {
                if (!controller.signal.aborted) {
                    setValues(value);
                    setBaseline(value);
                }
            })
            .catch((error_: unknown) => {
                if (!isCancelled(error_)) {
                    setError(errorMessage(error_));
                }
            });
        return () => {
            controller.abort();
        };
    }, []);
    const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
    return (
        <form
            className='form-stack'
            id='app-settings-form'
            onSubmit={(event) => {
                event.preventDefault();
                if (!values || pending || !dirty) {
                    return;
                }
                setPending(true);
                setError('');
                setSaved(false);
                void api('/api/settings/app', 'POST', {
                    ...values,
                    public_url: values.public_url.trim(),
                })
                    .then(async () => {
                        const session = await api<Session>('/api/session');
                        setCSRF(session.csrf);
                        setSaved(true);
                        setBaseline(values);
                    })
                    .catch((error_: unknown) => {
                        setError(errorMessage(error_));
                    })
                    .finally(() => {
                        setPending(false);
                    });
            }}
        >
            <DirtyForm dirty={dirty || pending} />
            {values && (
                <>
                    <FormField
                        help={t(
                            '反向代理的對外網址，用於登入 Cookie 與請求驗證。'
                        )}
                        id='settings-public-url'
                        label={t('網站網址')}
                    >
                        <input
                            onChange={(event) => {
                                setSaved(false);
                                setValues({
                                    ...values,
                                    public_url: event.target.value,
                                });
                            }}
                            placeholder='https://rss.example.com'
                            type='url'
                            value={values.public_url}
                        />
                    </FormField>
                    <CheckboxField
                        checked={values.allow_private_feeds}
                        help={t('僅在訂閱來源位於內網時啟用。')}
                        id='settings-private-feeds'
                        label={t('允許存取內網 RSS')}
                        onChange={(checked) => {
                            setSaved(false);
                            setValues({
                                ...values,
                                allow_private_feeds: checked,
                            });
                        }}
                    />
                    <div className='form-actions'>
                        <button
                            aria-busy={pending}
                            className='button primary'
                            disabled={pending || !dirty}
                            type='submit'
                        >
                            {pending && (
                                <Icon className='is-loading' name='loading' />
                            )}
                            {t('儲存網站設定')}
                        </button>
                    </div>
                </>
            )}
            <Feedback message={t(error)} />
            {saved && (
                <p className='field-help' role='status'>
                    {t('網站設定已儲存')}
                </p>
            )}
        </form>
    );
}

function PasswordSettings({
    onAuthenticated,
}: {
    onAuthenticated: () => Promise<void>;
}): JSX.Element {
    const { t } = usePreferences();
    const [confirm, setConfirm] = useState('');
    const [current, setCurrent] = useState('');
    const [error, setError] = useState('');
    const [password, setPassword] = useState('');
    const [pending, setPending] = useState(false);
    return (
        <form
            className='form-stack'
            id='password-form'
            onSubmit={(event) => {
                event.preventDefault();
                if (pending) {
                    return;
                }
                setPending(true);
                setError('');
                void (async () => {
                    if (password !== confirm) {
                        throw new Error('兩次輸入的密碼不一致');
                    }
                    await api('/api/settings/password', 'POST', {
                        current_password: current,
                        new_password: password,
                        confirm_password: confirm,
                    });
                    await onAuthenticated();
                })()
                    .catch((error_: unknown) => {
                        setError(errorMessage(error_));
                    })
                    .finally(() => {
                        setCurrent('');
                        setPassword('');
                        setConfirm('');
                        setPending(false);
                    });
            }}
        >
            <DirtyForm
                dirty={Boolean(current || password || confirm || pending)}
            />
            <FormField id='current-password' label={t('目前密碼')}>
                <input
                    autoComplete='current-password'
                    onChange={(event) => {
                        setCurrent(event.target.value);
                    }}
                    required
                    type='password'
                    value={current}
                />
            </FormField>
            <FormField id='new-password' label={t('新密碼')}>
                <input
                    autoComplete='new-password'
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                    required
                    type='password'
                    value={password}
                />
            </FormField>
            <FormField id='confirm-new-password' label={t('再次輸入新密碼')}>
                <input
                    autoComplete='new-password'
                    onChange={(event) => {
                        setConfirm(event.target.value);
                    }}
                    required
                    type='password'
                    value={confirm}
                />
            </FormField>
            <p className='field-help'>{t('修改後所有裝置都需重新登入。')}</p>
            <div className='form-actions'>
                <button
                    aria-busy={pending}
                    className='button primary'
                    disabled={pending || !(current || password || confirm)}
                    type='submit'
                >
                    {pending && <Icon className='is-loading' name='loading' />}
                    {t('修改密碼')}
                </button>
            </div>
            <Feedback message={t(error)} />
        </form>
    );
}
