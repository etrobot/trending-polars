-- 开盘啦"首页信息抓取辅助接口。
--
-- 只操作明确包含"开盘啦"的窗口；找不到应用或结构异常时立即失败。
--
-- 用法：
--   osascript scripts/kpl_homepage.applescript snapshot market      -- 大盘指数（上证、深证、创业板等）
--   osascript scripts/kpl_homepage.applescript snapshot hot         -- 热门板块/个股
--   osascript scripts/kpl_homepage.applescript snapshot sectors     -- 行业板块排名
--   osascript scripts/kpl_homepage.applescript snapshot sentiment   -- 市场情绪（涨跌家数、涨停/跌停等）
--   osascript scripts/kpl_homepage.applescript snapshot all         -- 首页全部信息

property stoleFocus : false

on run argv
    if (count of argv) < 2 then error my usageText()
    set commandName to item 1 of argv as text

    if commandName is "snapshot" then
        set snapshotKind to item 2 of argv as text
        if snapshotKind is not in {"market", "hot", "sectors", "sentiment", "all"} then ¬
            error "未知查询类型：" & snapshotKind & linefeed & my usageText()
        return my takeSnapshot(snapshotKind)
    end if

    error my usageText()
end run

on usageText()
    return "用法：snapshot market|hot|sectors|sentiment|all"
end usageText

on takeSnapshot(snapshotKind)
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "开盘啦") then error "开盘啦尚未运行"
        tell process "开盘啦"
            my ensureWindowAvailable(it)
            set kplWindow to my findKaiPanLaWindow(it)
            if kplWindow is missing value then error "未找到开盘啦窗口"
            delay 0.5

            set snapshotResult to my snapshotPage(kplWindow, snapshotKind)
            my restoreForegroundApp(previousApp)
            return snapshotResult
        end tell
    end tell
end takeSnapshot

on snapshotPage(kplWindow, snapshotKind)
    set outputLines to {"KPL_HOMEPAGE_V1", "MODE|" & snapshotKind}
    tell application "System Events"
        -- 收集首页所有可见文本元素
        set allItems to (static texts of kplWindow) & (text fields of kplWindow) & (buttons of kplWindow)

        if snapshotKind is "market" then
            -- 大盘指数区域：通常包含"上证指数""深证成指""创业板指"等关键词及数值
            set end of outputLines to "SECTION|market_index"
            repeat with uiItem in allItems
                set itemText to my elementText(uiItem)
                if itemText is not "" then
                    set end of outputLines to "TEXT|" & my sanitize(itemText)
                end if
            end repeat

        else if snapshotKind is "hot" then
            -- 热门板块/个股区域：通常包含涨幅榜、热门概念等
            set end of outputLines to "SECTION|hot_stocks"
            repeat with uiItem in allItems
                set itemText to my elementText(uiItem)
                if itemText is not "" then
                    set end of outputLines to "TEXT|" & my sanitize(itemText)
                end if
            end repeat

        else if snapshotKind is "sectors" then
            -- 行业板块排名：行业名称、涨跌幅等
            set end of outputLines to "SECTION|sectors"
            repeat with uiItem in allItems
                set itemText to my elementText(uiItem)
                if itemText is not "" then
                    set end of outputLines to "TEXT|" & my sanitize(itemText)
                end if
            end repeat

        else if snapshotKind is "sentiment" then
            -- 市场情绪：涨跌家数、涨停/跌停数量、成交量等
            set end of outputLines to "SECTION|sentiment"
            repeat with uiItem in allItems
                set itemText to my elementText(uiItem)
                if itemText is not "" then
                    set end of outputLines to "TEXT|" & my sanitize(itemText)
                end if
            end repeat

        else if snapshotKind is "all" then
            -- 首页全部信息
            set end of outputLines to "SECTION|full_homepage"
            repeat with uiItem in allItems
                set itemText to my elementText(uiItem)
                if itemText is not "" then
                    set end of outputLines to "TEXT|" & my sanitize(itemText)
                end if
            end repeat

            -- 额外抓取表格数据（如有板块排行列表等）
            try
                repeat with scrollItem in scroll areas of kplWindow
                    repeat with tableItem in tables of scrollItem
                        if (count of rows of tableItem) <= 200 and (count of columns of tableItem) <= 30 then
                            set end of outputLines to "TABLE|rows=" & (count of rows of tableItem) & " cols=" & (count of columns of tableItem)
                            repeat with uiItem in rows of tableItem
                                set rowValues to {}
                                repeat with rowItem in UI elements of uiItem
                                    set cellText to my elementText(rowItem)
                                    if cellText is not "" then set end of rowValues to cellText
                                end repeat
                                if (count of rowValues) > 0 then set end of outputLines to "ROW|" & my joinList(rowValues, "|")
                            end repeat
                        end if
                    end repeat
                end repeat
            end try
        end if
    end tell

    return my joinList(outputLines, linefeed)
end snapshotPage

-- 查找开盘啦窗口
on findKaiPanLaWindow(appProcess)
    tell application "System Events"
        repeat 4 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists static text "开盘啦") or (title of candidateWindow contains "开盘啦") then return contents of candidateWindow
                end tell
            end repeat
            delay 0.35
        end repeat

        -- 第二遍：尝试激活后扫描
        my bringProcessToFront(appProcess)
        repeat 3 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists static text "开盘啦") or (title of candidateWindow contains "开盘啦") then return contents of candidateWindow
                end tell
            end repeat
            delay 0.4
        end repeat
    end tell

    return missing value
end findKaiPanLaWindow

on ensureWindowAvailable(appProcess)
    tell application "System Events"
        repeat 12 times
            try
                if (count of windows of appProcess) > 0 then return
            end try
            try
                get name of appProcess
            end try
            delay 0.4
        end repeat
        my bringProcessToFront(appProcess)
        repeat 8 times
            try
                if (count of windows of appProcess) > 0 then return
            end try
            delay 0.4
        end repeat
    end tell
    error "开盘啦进程在运行但读不到任何窗口。请确保开盘啦窗口在当前桌面、未最小化、屏幕未锁定后重试。"
end ensureWindowAvailable

on bringProcessToFront(appProcess)
    tell application "System Events"
        try
            if frontmost of appProcess is true then return
        end try
        set my stoleFocus to true
        try
            set frontmost of appProcess to true
        end try
    end tell
    delay 0.6
end bringProcessToFront

on saveForegroundApp()
    tell application "System Events"
        try
            set frontApp to first application process whose frontmost is true
            return name of frontApp
        end try
    end tell
    return missing value
end saveForegroundApp

on restoreForegroundApp(previousAppName)
    if previousAppName is missing value then return
    if not my stoleFocus then return
    set my stoleFocus to false
    tell application "System Events"
        try
            set frontmost of process previousAppName to true
        end try
    end tell
end restoreForegroundApp

on elementText(uiItem)
    tell application "System Events"
        try
            set itemValue to value of uiItem
            if itemValue is not missing value and (itemValue as text) is not "" then return my sanitize(itemValue as text)
        end try
        try
            set itemName to name of uiItem
            if itemName is not missing value and (itemName as text) is not "" then return my sanitize(itemName as text)
        end try
        try
            set itemDesc to description of uiItem
            if itemDesc is not missing value and (itemDesc as text) is not "" then return my sanitize(itemDesc as text)
        end try
    end tell
    return ""
end elementText

on sanitize(sourceText)
    set cleanText to sourceText as text
    set cleanText to my replaceText(return, " ", cleanText)
    set cleanText to my replaceText(linefeed, " ", cleanText)
    set cleanText to my replaceText("|", "｜", cleanText)
    return cleanText
end sanitize

on replaceText(findText, replacementText, sourceText)
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to findText
    set textItems to text items of sourceText
    set AppleScript's text item delimiters to replacementText
    set replacedText to textItems as text
    set AppleScript's text item delimiters to previousDelimiters
    return replacedText
end replaceText

on joinList(itemsToJoin, delimiterText)
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiterText
    set joinedText to itemsToJoin as text
    set AppleScript's text item delimiters to previousDelimiters
    return joinedText
end joinList