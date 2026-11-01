# empty-response-retry

Tự động xử lý assistant final response rỗng trong subagent session:

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

## Phạm vi

Chuỗi retry response rỗng (cùng model → Gemini → Sonnet) chỉ chạy khi `PI_SUBAGENT_ID` khác rỗng
sau khi trim whitespace. `pi-herdr-subagents` đặt biến này khi spawn hoặc resume subagent.
Session chính giữ nguyên response rỗng, không tự retry, đổi model hay thông báo vì response rỗng.

Fallback lỗi terminated-subagent / WebSocket idle timeout → Opus và Opus-error → Gemini vẫn áp dụng
ở mọi session. Guard `subagent_done` và việc khôi phục model khi run settle không thay đổi.

## Chặn `subagent_done` khi chưa có câu trả lời dạng text

`pi-herdr-subagents` chỉ trả về **text** của assistant message cuối cùng cho session cha; thinking
bị bỏ qua. Một số model (đặc biệt `gemini-3.8-flash-high`) hay viết đáp án trong thinking rồi gọi
`subagent_done {}` ngay, khiến kết quả là `Sub-agent exited without output`.

Extension chặn tool call `subagent_done` (trả `block` kèm lý do cho model) trừ khi:

- assistant message chứa lời gọi có text khác whitespace, hoặc
- assistant message ngay trước đó là câu trả lời text thuần (không có tool call).

Model nhận lỗi và được yêu cầu viết kết quả cuối cùng dạng text. Sau
`MAX_SUBAGENT_DONE_BLOCKS` (2) lần chặn liên tiếp, extension cho qua để tránh vòng lặp; bộ đếm reset
khi cho qua hoặc khi run settle.

Sau khi run settle, extension khôi phục model ban đầu nếu người dùng chưa tự đổi model. Không thay đổi
model mặc định của các session mới.

## Reload

Package này đã khai báo extension trong `package.json`. Nếu repo đã được đăng ký trong Pi settings, chạy:

```text
/reload
```

Không cần symlink thêm extension riêng; làm vậy có thể load extension hai lần.

## Debug simulation

Để kiểm tra luồng retry mà không cần chờ provider trả về response rỗng, đặt số response `stop` đầu tiên
cần ép thành empty và dùng `PI_SUBAGENT_ID=test` để giả lập môi trường subagent:

```bash
PI_SUBAGENT_ID=test PI_EMPTY_RETRY_SIMULATE=2 pi -p "say hi"
```

Simulation cũng chỉ chạy trong subagent session; đặt riêng `PI_EMPTY_RETRY_SIMULATE` ở session chính
không bật retry. Biến simulation chỉ phục vụ kiểm thử thủ công và không bật mặc định.
