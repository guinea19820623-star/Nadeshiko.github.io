# 撫子桌寵 v0.3.2

會在螢幕下緣走來走去、偶爾飛一圈、被摸頭會害羞的撫子。她跟 Claude Code 連動：你送出提示她就開始想，Claude 動手用工具她就抱著平板工作，回答完會歡呼；用量超過 85% 會累，5 小時額度用完會睡著，碰到週上限會暈倒。

![各狀態截圖](docs/states.png)

> 這張圖是在雲端容器裡用 Electron 實際跑出來的畫面截圖（透明背景疊在漸層上）。

### 更新紀錄
- **v0.3.2（2026-10-21）**
  - **側睡不再飄起來**：側睡那張圖腳底下有一層零星的半透明殘影（約 110px），對齊地面時被當成腳底，人物實際浮在半空，點擊後才會「掉下去」。素材處理改成以不透明的實際底部對齊並清掉殘影（已驗證側睡時腳底貼地）。
  - **休眠喚醒後拎不起來**：你發現「重新調整尺寸就好」，我把「調尺寸」的動作做進喚醒流程：系統睡眠喚醒、解鎖、換顯示器、計時器突然隔很久（螢幕休眠）、以及每次開始拎起之前，都先把視窗大小差 1px 再改回來（透明視窗看不出來）並重建顯示資源。這是依你的線索推測的修法，我在 Linux 無法重現休眠，**請你實測**；若還是偶爾發生，用下面的喚醒快捷鍵一鍵修復。
  - **喚醒快捷鍵** `Ctrl+Alt+N`（Mac 是 Cmd+Option+N）：重整視窗、頂到最上層、人物醒來（躺著就爬起來，否則揮手）；人物在螢幕外會帶回右下角；按完可以直接點擊或拎起。系統匣圖示點一下、右鍵選單「喚醒」也是同樣效果。想換按鍵：關掉撫子，編輯設定檔 `settings.json` 的 `hotkey`（例如 `"CommandOrControl+Shift+F9"`）；設定檔在 Windows 是 `%APPDATA%\nadeshiko-pet\settings.json`。若按鍵被別的程式佔用，終端機會印出提示。
  - 快捷鍵本身我在 Linux 虛擬螢幕上無法測全域按鍵（只測了觸發後的行為：躺著會爬起來、站著會揮手、可拎起），請你按一次確認。
- **v0.3.1（2026-10-21）** 修正拎起時圖片切換：原本兩種拎起姿勢會中途互換（先像抱起來、下一秒歪身子）。現在每次拎起隨機選一種（抱起來／歪身子），整段都用同一種，各自會眨眼。新增 `SUGGESTIONS.md`（改進建言，做完的畫掉）。
- **v0.3.0（2026-10-21）** 新動作與羊皮紙面板。
  - **坐下等待**：沒人理約 80 秒後隨機坐下（跪坐或側坐，會眨眼），語音「我坐一下～」。
  - **側身睡覺**：約 5 分鐘沒人理就躺下側睡；5 小時額度用完也改成躺著睡（原本是站著閉眼）。
  - **睡醒爬起來**：躺著（睡覺或暈倒）時被摸、被點，或 Claude 開始工作／額度恢復，都會依序 撐起 → 坐起揉眼 → 準備站起，再回到站立。語音「嗯……我睡醒了」。
  - **工作中**兩張圖交替（低頭看平板 ↔ 抬頭）、**被拎起**兩張交替（亂踢腳）、**出錯**改成困惑表情（頭上問號、手拿平板）。
  - **眨眼**：思考、工作、疲憊、揮手、東張西望、坐姿、困惑都有閉眼版，每隔幾秒眨一下。
  - **控制面板**換成羊皮紙卷軸（無邊框，可拖曳上方卷軸移動，右上角 ✕ 關閉）；動作清單新增「坐下休息」「睡醒爬起來」。
  - **保持最上層**改用最高層級並每 3 秒重新頂上來，網頁或影片全螢幕時比較不會被蓋住。**Windows 上實際效果我無法驗證**：如果是「獨占全螢幕」的遊戲或程式，任何桌面視窗都蓋不上去，這是系統限制。
  - 右鍵選單仍是系統原生樣式（Electron 的原生選單不能換皮膚）；要做成羊皮紙需要自己畫一個選單視窗，等你的選單框架素材。
  - 新增語音台詞：坐下、睡醒各 3 句。**請重新執行** `node tools/generate-voices.js`（只會補缺的）。
- **v0.2.1（2026-10-20）** 台詞微調（驚嘆號改「～」避免斷尾音、稱呼改「主人」、疲憊／暈倒文字）；修正螢幕休眠喚醒後「能摸頭但拎不起來」：喚醒、解鎖、換顯示器時主程序重設滑鼠穿透狀態並清掉殘留按住狀態，另外滑鼠停在她身上時每秒自動重新宣告一次。（在 Linux 只能測到事件流程沒有錯誤，真正的休眠喚醒要請你在 Windows 上實測。）
- **v0.2.0（2026-10-20）** 新增「語音台詞」。
  - 21 種狀態／表情（打哈欠、揮手、摸頭、被拎起、思考、工作、完成、疲憊、暈倒…）各有 3 句台詞，每次隨機挑一句，不會連續重複；頭上小字會跟著唸的那句一起換。
  - 聲音是**事先生成好的音檔**（`app/voice/`），執行時只是播放，不需要 TTS 服務在跑。
  - 右鍵選單、控制面板都有「語音」開關與音量；沒有音檔時照常只出字，不會壞。
  - 重要：這包**不含音檔**（雲端環境連不到你的 Breeze），要在你的電腦上跑一次 `node tools/generate-voices.js`，見第 10 節。
- **v0.1.1（2026-10-20）** 修正「角色移動後，頭上泡泡停在右下角不跟著走」。
  - 泡泡改成每一格都重新對準她目前畫出來的頭頂（走路、飛行、被拎起、跳起來都跟著），下面多了指向頭的小尾巴。
  - 靠近螢幕左右邊緣時，泡泡自動往內側移，小尾巴仍指著頭；太靠上面時往下讓。
  - 視窗左右多留一段透明邊給泡泡用（透明處滑鼠照樣穿透）。
  - 移動視窗一律帶固定寬高（`setBounds`），並定期檢查尺寸：Windows 在 125%／150% 縮放時，反覆移動透明視窗可能讓視窗大小漂移，這很可能就是泡泡跑掉的原因。
  - 更新方式：關掉撫子，用新的 zip 覆蓋整個資料夾（`app/node_modules` 可以保留，不用重新下載 Electron），再雙擊 `start-windows.bat`。hooks 不用重裝。
- **v0.1（2026-10-19）** 第一版。

---

## 1. 最少步驟（Windows 11）

需要 **Node.js 20 以上，建議 22 LTS**（終端機打 `node -v` 確認；沒有就到 nodejs.org 裝 LTS 版）。

1. 把整個 `desktop-pet` 資料夾放到你喜歡的位置，例如 `C:\nadeshiko-pet`。
2. 雙擊 **`start-windows.bat`**。第一次會自動下載 Electron（約 100MB，要等一下），之後秒開。
3. 撫子出現在右下角後，在她身上 **按右鍵** → 「測試狀態」或「控制面板與模擬器…」先玩一輪，確認畫面正常。
4. 連動 Claude Code：在 `desktop-pet` 資料夾開終端機，執行
   ```
   node tools/install-claude.js --dry-run   ← 先看會改成什麼樣子（不寫檔）
   node tools/install-claude.js             ← 真的安裝（會先備份 settings.json）
   ```
   然後重開 Claude Code。想移除就 `node tools/install-claude.js --uninstall`，會還原成原本的樣子。

macOS 一樣，只是第 2 步改雙擊 `start-mac.command`（第一次可能要在「系統設定 → 隱私權與安全性」允許）。

也可以用 npm 指令：`npm run setup`（裝 Electron）、`npm start`（啟動）、`npm run hooks:install`、`npm test`（跑邏輯測試）。

## 2. 怎麼跟她互動

| 動作 | 結果 |
|---|---|
| 左鍵點一下 | 開心地跳一下、冒愛心 |
| 滑鼠在她頭上左右來回撫摸 | 摸頭撒嬌（臉紅雙手捧臉），停手就結束 |
| 按住拖曳 | 像被拎起後頸一樣晃來晃去，放開會掉回地面；從很高的地方放手會暈一下 |
| Ctrl + 滾輪（游標在她身上） | 放大縮小 |
| 右鍵 | 選單：尺寸、動作、測試狀態、各種開關、控制面板、結束 |
| 工作列的小圖示 | 跟右鍵選單一樣（她跑不見時用「回到螢幕右下角」） |

她身上透明的地方（包含左右留給泡泡的空白）滑鼠會直接穿過去，不會擋到底下的視窗。**尺寸、位置、開關都會記住**，下次開還是一樣。

### 尺寸
- 右鍵 → 尺寸：迷你 140 / 小 190 / 中 250 / 大 330 / 特大 440，或「放大一點、縮小一點」
- 控制面板的滑桿：100 到 640 像素任意調
- 縮放時以腳底為基準，不會跳走

## 3. 狀態怎麼決定

優先序（高的蓋過低的）：

**使用者互動**（拖曳、摸頭）＞ **暈倒** ＞ **睡覺（5h 用完）** ＞ **疲憊** ＞ **等你確認** ＞ **工作中** ＞ **思考** ＞ **完成** ＞ **隨機行為**

| 桌寵狀態 | 觸發條件 | 用的圖 |
|---|---|---|
| 暈倒 | 7 天用量 ≥ 100%，或 Claude 回報撞到用量上限且週用量接近滿 | `faint` |
| 睡覺 | 5 小時用量 ≥ 100%，或撞到上限但週用量還沒滿；頭上顯示幾點恢復 | `sleep` |
| 疲憊 | 5 小時或 7 天任一 ≥ 85%（門檻可在控制面板調）；偶爾打哈欠 | `tired` / `yawn` |
| 等你確認 | Claude 跳出權限詢問（`permission_prompt`） | `wave` 揮手 |
| 工作中 | Claude 正在用工具（`PreToolUse` / `PostToolUse`），頭上顯示工具名 | `work` |
| 思考 | 你剛送出提示（`UserPromptSubmit`） | `think` |
| 完成 | 回答結束（`Stop`），歡呼 6 秒 | `cheer` |
| 打招呼 | 開新工作階段（`SessionStart`） | `wave` |
| 隨機行為 | 沒事的時候：待機呼吸眨眼、走動、飛一圈、張望、打哈欠、伸懶腰、揮手、歡呼、換姿勢；被冷落 12 分鐘以上會睡午覺 | 各種 |

疲憊時如果 Claude 還在工作，頭上會寫「還在工作…體力剩 12%」，所以兩件事都看得到。滑鼠移到她身上會出現**體力條**（5h、週剩餘的百分比），疲憊以上會一直顯示；也可以在選單打開「體力條常駐」。

同時開好幾個 Claude Code 視窗時，取最忙的那一個。思考或工作超過 10 分鐘沒有新事件（例如 Claude 當掉），會自動當作結束。

## 4. 連動的原理（查證過官方文件）

資料都放在 `~/.nadeshiko-pet/`（Windows 是 `C:\Users\你\.nadeshiko-pet\`），右鍵「打開狀態資料夾」可以直接看：

```
sessions/<工作階段>.json   hooks 寫：這個 Claude Code 視窗正在做什麼
usage.json                狀態列腳本寫：5 小時 / 7 天用量與重置時間
limit.json                hooks 寫：剛剛撞到用量上限
```

桌寵每 0.6 秒讀一次。桌寵沒開時 hooks 照樣寫檔，不影響 Claude。

### 4.1 工作狀態：Claude Code hooks
來源：<https://code.claude.com/docs/en/hooks>

`install-claude.js` 會在 `~/.claude/settings.json` 的 `hooks` 裡，為這些事件加上 `node ".../hooks/pet-hook.js"`：
`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Notification`、`SubagentStart`、`PreCompact`、`Stop`、`StopFailure`、`SessionEnd`。

- 每個 hook 都設 `"async": true`（官方欄位：在背景執行、不阻塞），腳本一律 exit 0、不輸出任何東西，**不會拖慢或擋住 Claude**。
- `StopFailure` 的 `error` 是 `rate_limit` 時代表撞到用量上限；`Notification` 的 `quota_auto_resume_fired` 代表額度恢復後自動續跑。
- 路徑一律寫成正斜線，因為 Windows 上 Claude Code 用 Git Bash 執行 hook，反斜線會被吃掉（官方文件有特別提醒）；沒有 Git Bash 時會改用 PowerShell，`node "C:/..."` 兩邊都能跑。
- 你原本的 hooks 都會保留，安裝前會備份成 `settings.json.bak-時間`。

### 4.2 用量：狀態列腳本收到的 `rate_limits`
來源：<https://code.claude.com/docs/en/statusline>

Claude Code 會把一包 JSON 從 stdin 傳給狀態列指令，其中：

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

- `used_percentage` 是 0 到 100，`resets_at` 是 Unix 秒。
- **只有 Pro / Max 訂閱才有**，而且要等工作階段第一次收到回應後才出現；兩個視窗可能各自缺席，過了 `resets_at` 也會被拿掉。腳本都有處理。
- 狀態列在「新的助手訊息到達」等時機才重跑（官方寫有 300ms 防抖），所以用量是**用 Claude Code 時才更新**，平常不會自己變。
- 安裝時如果你原本就有自己的狀態列，會被記在 `~/.nadeshiko-pet/statusline-chain.json`，撫子的腳本讀完用量後**照樣執行你原本的指令並顯示它的結果**，畫面不變。沒有的話會顯示 `撫子 │ 模型 │ ctx 12% │ 5h 24%（3h10m） │ 週 41%（2天後重置）`。

### 4.3 Claude Desktop 呢？（誠實評估）

- **Desktop 的「Code」分頁可以**：官方文件寫明 Desktop 與 CLI 共用 `~/.claude/settings.json`，hooks 兩邊都會觸發（<https://code.claude.com/docs/en/desktop> 的 Shared configuration 一節），所以思考、工作、完成、撞上限都會連動。
- **Desktop 的一般聊天沒有辦法**：它沒有 hooks、沒有狀態列、也沒有公開的本機事件介面，我找不到正當的本機訊號可以知道「它正在想」或「它用了多少」。不去硬湊（例如讀它的內部快取或截圖辨識），因為很容易壞、也不該碰。
- **用量是全帳號共用的**：5 小時與週額度是同一個方案在算，所以只要你偶爾用一下 Claude Code（終端機或 Desktop 的 Code 分頁），撫子就會拿到最新數字，包含你在 Desktop 聊天用掉的部分。
- 替代方案：控制面板的「模擬器」可以手動拉用量滑桿；或在終端機 `node tools/simulate.js usage 90 60` 直接設定。

## 5. 模擬器（驗收用，不需要 Claude）

**控制面板**（右鍵 →「控制面板與模擬器…」）：
- 「測試狀態」：直接切到任一狀態，選「自動」回到連動
- 「模擬器」：按鈕送出假的 Claude 事件（開新工作階段、送出提示、呼叫工具、要求權限、回答結束、撞到上限、額度恢復、API 錯誤、結束），走的是**跟真正 hooks 完全一樣的寫檔路徑**，所以這裡正常，接上 Claude 就會正常
- 兩條滑桿設定 5h / 7d 用量，按「送出用量」
- 下方即時顯示狀態檔內容

**命令列**：
```
node tools/simulate.js think          思考
node tools/simulate.js work Edit      工作中（工具名可省略）
node tools/simulate.js wait | done | hello | error
node tools/simulate.js usage 90 40    5h 90%、週 40% → 疲憊
node tools/simulate.js limit          撞到上限
node tools/simulate.js clear          清掉模擬資料
node tools/simulate.js demo           自動輪播全部狀態（約 1 分鐘）
```

## 6. 素材對照表

原圖沒有被修改。`tools/prepare_sprites.py` 會把 alpha < 8 的像素清成 0（Qwen 圖約 40% 的像素是肉眼看不到的 alpha=1 紫色殘留）、把 1254 尺寸的圖縮到同一個角色比例、以頭部中心與腳底對齊到同一張畫布，輸出 660×660 的 PNG 到 `app/sprites/`。

| 狀態鍵 | 原始檔 | 用途 |
|---|---|---|
| idle | Qwen_image_2.1_00027 | 待機（雙手交握微笑） |
| blink / happy | Qwen_image_2.1_00028 | 眨眼（跟 00027 只差眼睛，完美對齊）、被點一下的開心 |
| pat | Qwen_image_2.1_00030 | 摸頭撒嬌（臉紅捧臉） |
| curious / curious2 | Qwen_image_2.1_00026 / 00036 | 張望、出錯時的疑惑 |
| think | Qwen_image_2.1_00031 | 思考（泡泡） |
| work | Qwen_image_2.1_00032 | 工作中（平板） |
| yawn | Qwen_image_2.1_00033 | 打哈欠（也用在疲憊時） |
| wave | Qwen_image_2.1_00038 | 揮手、打招呼、等你確認 |
| sleep | Qwen_image_2.1_00042 | 睡覺（5h 用完、睡午覺） |
| tired | Qwen_image_2.1_00023 | 疲憊（揉眼睛、頭髮翹） |
| stretch | Qwen_image_2.1_00035 | 伸懶腰 |
| cheer | Qwen_image_2.1_00045 | 完成、歡呼 |
| faint | Qwen_image_2.1_00024 | 暈倒（週上限）、高處摔下暈一下 |
| drag | Qwen_image_2.1_00059 | 被拎起、下落 |
| fly1 / fly2 | Qwen_image_2.1_00054 / 00055 | 飛行（兩張交替） |
| walk1–4 | Qwen_image_2.1_00016–00019 | 走路輪播 |
| walk5 | uploads/hearth/9ec4f8ce…（1254px） | 大跨步（已處理，目前沒排進輪播，留著備用） |
| pose | uploads/hearth/1793e431…（1254px，最初的角色圖） | 隨機換姿勢 |

沒用到：`uploads/hearth/87024f76…` 和 00018 幾乎一模一樣（平均像素差 3.6），用 00018。

以後加新圖：把檔名加進 `prepare_sprites.py` 的 `SPRITES`，執行
`python tools/prepare_sprites.py --src <素材資料夾>`（需要 `pip install pillow numpy`）。

## 7. 我自己決定、改了的地方

- **5 小時額度用完 → 睡覺，週上限才暈倒**。原本只有「85% 疲憊、週上限暈倒」，但 5h 用完也會被擋，用「睡到幾點再戰」比較貼切，也跟暈倒區分開。門檻三個都能在控制面板調。
- **體力條顯示「剩下多少」**而不是「用了多少」，頭上字也統一成「體力剩 12%」。
- **拖曳一律像拎後頸**：不管抓哪裡，都換成被拎起的圖、以頭為軸擺盪，放手會掉回地面，從很高放手會暈 2 秒。
- **眨眼**：00027 和 00028 只差眼睛，剛好拿來做待機眨眼（偶爾連眨兩下）。
- **側身與飛行圖放大 6–20%**：這兩組孵出來臉比正面小，不放大的話切換時會覺得人縮水。
- **走路順序**：沒有左右腳交替的素材，用「大步 → 收腳 → 抬後腳 → 跨出」四張輪播加上下彈跳，往左走時鏡像。
- **頭上小字**：各狀態與動作有一句短台詞（「呼啊～」「哇！放我下來～」），不喜歡可以關。
- **保留你原本的狀態列**：安裝程式偵測到就串接，不會蓋掉。
- **被冷落 12 分鐘以上會睡午覺**，滑鼠或 Claude 有動靜就醒。
- 加了工作列小圖示和「回到螢幕右下角」，她跑到別的螢幕或找不到時用。

## 8. 還缺的素材與建議提示詞

依重要性排序。**正面的圖請用 00027 當底圖做「圖片編輯」**（只改表情或手），這樣孵出來會跟現有的完美對齊，切換時身體不會抖（00028 就是這樣成功的）。

共用角色描述（貼在每個提示詞前面）：
```
chibi anime girl, long wavy peach-blonde hair, large orange flower hair ornament on one side with dangling gold bead ornaments,
amber eyes, white off-shoulder ruffled tiered dress with orange bow and gold beaded trim, barefoot,
full body, soft cel shading, clean lineart, transparent background, no shadow on ground
```

1. **往左走的走路圖 4 張**（目前往左是鏡像，花飾會跑到另一邊）
   `same character walking to the left, side view, [contact pose: legs apart, front heel down] / [passing pose: back foot lifted] ...` 各一張，跟現有 00016–00019 同一套姿勢的反方向。
2. **真正換腳的走路圖 2 張**（讓走路更自然）
   `side view walking to the right, LEFT leg forward stride` 與 `side view walking to the right, RIGHT leg forward stride`，兩張只差哪隻腳在前。
3. **各表情的閉眼版**（讓思考、工作、疲憊也會眨眼）：以 00031、00032、00023 為底圖編輯 `keep everything identical, only close her eyes gently`。
4. **工作中第二張**：以 00032 為底圖編輯 `same pose, looking up from the tablet at the viewer, small smile`，兩張交替就像邊打字邊抬頭。
5. **被拎起第二張**：以 00059 為底圖編輯 `same pose, legs kicking, flustered expression, sweat drop`，拖曳時兩張交替。
6. **出錯／困惑**：以 00027 為底圖編輯 `tilting head, question mark above head, confused expression, one finger on cheek`。
7. **從暈倒爬起來**：`sitting up on the floor, rubbing head with one hand, dizzy swirl fading, embarrassed smile`。
8. （進階）**坐在視窗邊緣**：`sitting with legs dangling, viewed from the front, hands on the edge`，之後可以做「坐在視窗頂端」。

## 9. 驗證狀況

在雲端容器（Linux + Xvfb）裡做到的：
- `npm test`：17 項測試全過（含台詞表檢查）（狀態機優先序、門檻、過期與上限判斷、hook 腳本實際讀 stdin 寫檔、狀態列腳本、安裝與移除時原設定完整保留並能還原原本狀態列）
- 用 Playwright 驅動 Electron 44 實際啟動：透明視窗、各狀態切換、走路會移動視窗、飛行、拖曳、摸頭偵測、控制面板改尺寸（以腳底為基準）、設定存檔、模擬器按鈕，畫面截圖就是上面那張

**沒驗證到、要你在自己電腦上看的：**
- Windows 上的點擊穿透手感（Linux 不支援 `forward` 參數，邏輯有寫但沒實測）、拖曳甩動的手感、工作列圖示
- 真正接上 Claude Code 的 hooks 與狀態列（文件查證過、腳本有用模擬輸入測，但沒有真的 Claude Code 可以跑）
- 高 DPI 縮放（125% / 150%）下的清晰度
- macOS 只照官方行為寫，完全沒測

遇到問題時：右鍵 →「打開狀態資料夾」看 JSON 有沒有在更新；hooks 可以在 Claude Code 裡打 `/hooks` 檢查；設定 `NADESHIKO_PET_DEBUG=1` 時 hook 錯誤會印到 stderr。

## 10. 語音台詞

### 運作方式
- 台詞表：`app/voice/lines.json`。每個狀態 2~3 句，`text` 是頭上小字，`say` 是實際唸出來的字（省略就唸 `text`，例如 `Zzz…` 唸成「呼……呼……」）。
- 音檔：`app/voice/<狀態>_<1~3>.mp3`（也認 `.ogg` / `.wav`）。檔名跟台詞表的順序對應，所以**改了台詞文字之後要重新生成該狀態**。
- 播放：動作類（打哈欠、揮手、摸頭、拖曳…）進入動作時挑一句，字與聲音同步；Claude 狀態類（思考、工作、完成、疲憊…）在狀態切換時只出聲，字仍是即時資訊（工具名稱、剩餘體力、恢復時間）。
- 不吵：同一狀態有冷卻（一般 4 秒；思考／工作 60 秒；疲憊／睡覺／暈倒 2 分鐘）；新的一句會蓋掉還沒唸完的舊句；關掉「語音」或音量 0 就完全靜音，字不受影響。
- 載入：第一次要唸才讀檔，之後留在記憶體；63 句總共約 1~2 MB（mp3，單聲道 24kHz 48kbps，每句 1~3 秒、約 10~25 KB）。若沒有 ffmpeg 而保留 Breeze 的 wav，每句約 100~300 KB，總共十幾 MB，也還能用，但建議裝 ffmpeg 轉 mp3。

### 生成音檔（在你自己的電腦上）
1. 先把 Breeze-TTS 服務開起來（預設 `http://127.0.0.1:8080`，聲音 `agent_girl`）。
2. 在 `desktop-pet` 資料夾執行：
   ```
   node tools/generate-voices.js
   ```
   已經有的音檔會跳過，只補缺的；`--force` 全部重做，`--only pat,wave` 只做指定狀態，`--list` 只列出不呼叫。
3. 重新啟動撫子（或右鍵關掉再開）。
- 句尾會自動補「……」避免尾音被吞；Breeze 一次只收一個請求，忙碌（409）時工具會自己等。
- 沒有 Breeze 可以用 `--engine edge`（先 `pip install edge-tts`），聲音是 `zh-TW-HsiaoChenNeural`。
- 想換聲音或服務位置：`--voice`、`--url`、`--model`。

**誠實說明：** 生成工具我在雲端只用一個假的 Breeze 伺服器測過（確認請求格式、409 重試、轉 mp3、檔名、播放與音量都正常），沒有碰過真的 Breeze。請求格式是照 OpenAI 相容的 `/v1/audio/speech` 寫的；如果你的 Breeze 回錯誤，工具會把伺服器回的訊息印出來，貼給我就能修。

## 11. 檔案結構

```
desktop-pet/
├─ start-windows.bat / start-mac.command   雙擊啟動
├─ package.json                            npm 捷徑指令
├─ app/                                    Electron 桌寵本體
│  ├─ main.js                              視窗、選單、拖曳、設定、讀狀態檔
│  ├─ preload.js
│  ├─ lib/bridge.js                        讀寫狀態檔（hooks 也用這支）
│  ├─ lib/statecore.js                     狀態機（純函式，有測試）
│  ├─ lib/voicecore.js                     語音台詞挑選（純函式，有測試）
│  ├─ voice/                               lines.json 台詞表 + 生成的音檔
│  ├─ renderer/                            畫面、行為、控制面板
│  ├─ sprites/                             處理好的立繪 + manifest.json
│  └─ assets/                              圖示
├─ hooks/pet-hook.js                       Claude Code hook
├─ hooks/pet-statusline.js                 狀態列腳本（讀用量）
├─ tools/install-claude.js                 安裝／移除 hooks 與狀態列
├─ tools/generate-voices.js                生成語音音檔
├─ tools/simulate.js                       命令列模擬器
├─ tools/prepare_sprites.py                素材處理
├─ test/                                   node --test
└─ docs/states.png                         各狀態截圖
```
