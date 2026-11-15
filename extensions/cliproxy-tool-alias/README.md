# cliproxy-tool-alias

Khôi phục tên tool khi Claude (qua CLIProxyAPI) gọi một tên alias bị cắt, ví dụ `zebra_write`
thay vì `write` hoặc `mandate_bash` thay vì `bash`. Không có extension này, Pi trả về
`Tool zebra_write not found`.

## Nguyên nhân

Khi cloak request Claude cho client không phải Claude Code, CLIProxyAPI đổi tên mọi tool thành
`mcp__<word>_<word>__<word>_<tên gốc>` (từ BIP-39, hash theo credential của client), rồi đổi lại ở
response. Bước đổi lại chỉ nhận alias đầy đủ hoặc alias có tiền tố `mcp__<server>__` đúng
(`claudeMCPAliasResolver.resolve` trong `internal/runtime/executor/claude_executor_request.go`).
Khi model bỏ tiền tố, tên bị chuyển nguyên về Pi.

## Cách hoạt động

Handler `message_end` chạy trước khi Pi tìm tool theo tên. Với mỗi tool call trong assistant message
của provider `cliproxyapi` mà tên không phải tool đang active, extension thử lần lượt:

1. Mỗi đoạn sau một `__` (bỏ tiền tố `mcp__<server>__`).
2. Đoạn đó sau khi bỏ một từ BIP-39 đầu (`zebra_write` → `write`).

Ứng viên đầu tiên trùng tên một tool đang active sẽ được dùng. Message được sửa tại chỗ, nên
session lưu tên đúng và lịch sử gửi cho các turn sau cũng đúng. Tên không khớp (ví dụ `zebra_deploy`
hoặc `my_bash`) được giữ nguyên để Pi báo lỗi như cũ.

## Giới hạn

- Chỉ áp dụng cho provider id `cliproxyapi` (`CLIPROXY_PROVIDERS` trong `index.ts`).
- Trong lúc stream, UI vẫn có thể hiện tên alias trước khi message hoàn tất.
- `bip39-words.ts` là bản sao `internal/runtime/executor/helps/claude_bip39_words.txt` của
  CLIProxyAPI; cập nhật nếu proxy đổi wordlist.
