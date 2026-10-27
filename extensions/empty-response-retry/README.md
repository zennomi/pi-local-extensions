# empty-response-retry

Tự động xử lý assistant final response rỗng:

1. Retry đúng request hiện tại một lần với model đang chọn.
2. Nếu vẫn rỗng, thử lần lượt:
   - `cliproxyapi/gemini-3.8-flash-high`
   - `cliproxyapi/claude-sonnet-5-5`
3. Mỗi fallback chỉ thử một lần. Nếu tất cả vẫn rỗng, dừng và hiển thị cảnh báo.

Nếu gặp lỗi terminated subagent có dạng đường dẫn session `.pi/agent/sessions/...` kèm
`subagent_done terminated`, tool call `subagent_done` kết thúc với `errorMessage: "terminated"`,
hoặc lỗi `WebSocket idle timeout after <ms>`, extension bỏ qua chuỗi retry rỗng và chuyển ngay sang
`cliproxyapi/claude-opus-5-5`. Nếu Opus vẫn trả về bất kỳ lỗi nào, extension tiếp tục chuyển sang
`cliproxyapi/gemini-3.8-flash-high`; `Response incomplete: content_filter` và
`rawStopReason: "incomplete.content_filter"` chỉ là một trường hợp cụ thể.

Response được xem là rỗng khi có `stopReason: "stop"`, không có tool call và không có text khác
whitespace. Response chỉ có thinking cũng được xem là rỗng. Các lỗi khác, abort và length không bị
retry bởi extension này.

Sau khi run settle, extension khôi phục model ban đầu nếu người dùng chưa tự đổi model. Không thay đổi
model mặc định của các session mới.

## Reload

Package này đã khai báo extension trong `package.json`. Nếu repo đã được đăng ký trong Pi settings, chạy:

```text
/reload
```

Không cần symlink thêm extension riêng; làm vậy có thể load extension hai lần.

## Debug simulation

Để kiểm tra luồng retry mà không cần provider thật, đặt số response `stop` đầu tiên cần ép thành empty:

```bash
PI_EMPTY_RETRY_SIMULATE=2 pi -p "say hi"
```

Biến môi trường chỉ phục vụ kiểm thử thủ công và không bật mặc định.
