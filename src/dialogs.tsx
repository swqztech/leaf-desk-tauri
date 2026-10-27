import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type ConfirmRequest = {
  type: 'confirm'
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

type PromptRequest = {
  type: 'prompt'
  title: string
  message: string
  /** 有值时必须原样输入才可确认；留空则作为自由输入 */
  expected?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (value: string | null) => void
}

type ChooseRequest = {
  type: 'choose'
  title: string
  message: string
  options: { id: string; label: string; danger?: boolean; primary?: boolean }[]
  cancelLabel?: string
  resolve: (id: string | null) => void
}

type DialogRequest = ConfirmRequest | PromptRequest | ChooseRequest

type DialogApi = {
  confirm: (opts: Omit<ConfirmRequest, 'type' | 'resolve'>) => Promise<boolean>
  prompt: (opts: Omit<PromptRequest, 'type' | 'resolve'>) => Promise<string | null>
  choose: (opts: Omit<ChooseRequest, 'type' | 'resolve'>) => Promise<string | null>
}

const DialogContext = createContext<DialogApi | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null)
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback(() => {
    setReq(null)
    setTyped('')
  }, [])

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise((resolve) => {
          setTyped('')
          setReq({ ...opts, type: 'confirm', resolve })
        }),
      prompt: (opts) =>
        new Promise((resolve) => {
          setTyped(opts.initial ?? '')
          setReq({ ...opts, type: 'prompt', resolve })
          queueMicrotask(() => inputRef.current?.focus())
        }),
      choose: (opts) =>
        new Promise((resolve) => {
          setTyped('')
          setReq({ ...opts, type: 'choose', resolve })
        }),
    }),
    [],
  )

  const cancel = () => {
    if (!req) return
    if (req.type === 'confirm') req.resolve(false)
    else req.resolve(null)
    close()
  }

  const confirmOk = () => {
    if (!req || req.type !== 'confirm') return
    req.resolve(true)
    close()
  }

  const promptOk = () => {
    if (!req || req.type !== 'prompt') return
    req.resolve(typed)
    close()
  }

  const chooseOk = (id: string) => {
    if (!req || req.type !== 'choose') return
    req.resolve(id)
    close()
  }

  const promptReady =
    req?.type === 'prompt'
      ? req.expected
        ? typed.trim() === req.expected
        : typed.trim().length > 0
      : false

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card dialog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-head">
              <div>
                <h3 id="app-dialog-title">{req.title}</h3>
              </div>
              <button className="btn btn-light" type="button" onClick={cancel}>
                关闭
              </button>
            </header>

            <div className="dialog-body">
              <p className="dialog-message">{req.message}</p>

              {req.type === 'prompt' && (
                <label className="dialog-prompt">
                  <span>
                    {req.expected ? (
                      <>
                        请输入 <code>{req.expected}</code> 以确认
                      </>
                    ) : (
                      '数据库名'
                    )}
                  </span>
                  <input
                    ref={inputRef}
                    value={typed}
                    spellCheck={false}
                    placeholder={req.placeholder || req.expected || ''}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && promptReady) promptOk()
                      if (e.key === 'Escape') cancel()
                    }}
                  />
                </label>
              )}
            </div>

            <footer className="modal-foot dialog-foot">
              <button className="btn btn-light" type="button" onClick={cancel}>
                {req.cancelLabel || '取消'}
              </button>
              <div className="modal-foot-right">
                {req.type === 'confirm' && (
                  <button
                    className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`}
                    type="button"
                    onClick={confirmOk}
                  >
                    {req.confirmLabel || '确定'}
                  </button>
                )}
                {req.type === 'prompt' && (
                  <button
                    className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`}
                    type="button"
                    disabled={!promptReady}
                    onClick={promptOk}
                  >
                    {req.confirmLabel || '确定'}
                  </button>
                )}
                {req.type === 'choose' &&
                  req.options.map((opt) => (
                    <button
                      key={opt.id}
                      className={`btn ${
                        opt.danger
                          ? 'btn-danger'
                          : opt.primary
                            ? 'btn-primary'
                            : 'btn-light'
                      }`}
                      type="button"
                      onClick={() => chooseOk(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
              </div>
            </footer>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) {
    throw new Error('useDialog 必须在 DialogProvider 内使用')
  }
  return ctx
}
