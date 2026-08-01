-- 同花顺生命周期辅助接口：启动后自动登录并切到模拟交易页，以及优雅退出。
--
-- 修复说明：
-- 1. 严格过滤控件角色：只允许 AXButton、AXRadioButton、AXCheckBox、AXTab、AXLink，坚决不碰静态文本或容器，防止发生 "begin failed" 权限/动作拒绝错误。
-- 2. 点击前检查 enabled 状态。
-- 3. 增加短延时和容错。

property windowWaitSeconds : 30
property loginWaitSeconds : 40

on run argv
	if (count of argv) is 0 then error my usageText()
	set commandName to item 1 of argv as text
	if commandName is "launch-flow" then
		return my launchFlow()
	else if commandName is "quit" then
		return my quitThs()
	else if commandName is "probe" then
		return my probeThs()
	else
		error my usageText()
	end if
end run

on usageText()
	return "用法：launch-flow | quit | probe"
end usageText

-- ---------------------------------------------------------------------------
-- probe：只读探测，不碰任何控件
-- ---------------------------------------------------------------------------
-- 光看进程不够：同花顺进程活着但窗口数为 0 时（最小化到 Dock、在其它 Space、
-- 屏幕锁定）下单脚本一样会失败，所以窗口数才是"可用"的判据。

on probeThs()
	tell application "System Events"
		if not (exists process "同花顺") then return "THS_PROBE|running=false|windows=0"
		try
			set windowCount to count of windows of process "同花顺"
		on error
			return "THS_PROBE|running=true|windows=0"
		end try
		return "THS_PROBE|running=true|windows=" & windowCount
	end tell
end probeThs

-- ---------------------------------------------------------------------------
-- launch-flow
-- ---------------------------------------------------------------------------

on launchFlow()
	tell application "System Events"
		if not (exists process "同花顺") then error "同花顺进程尚未出现，请先由调用方 open -a 启动"
	end tell

	set targetWindow to my waitForThsWindow(windowWaitSeconds)
	if targetWindow is missing value then error "等待同花顺窗口超时，未出现可交互窗口"

	set loginClicked to my clickLoginButton(targetWindow)

	set mainWindow to my waitForThsWindow(loginWaitSeconds)
	if mainWindow is missing value then error "LOGIN_PENDING|等待主交易界面超时（可能登录需手输或弹验证）"
	if loginClicked then
		if not my isMainTradingWindow(mainWindow) then
			set mainWindow to my waitForMainTradingWindow(loginWaitSeconds)
		end if
	end if

	my clickSidebarTradeButton(mainWindow)
	my clickSimulationTab(mainWindow)

	return "LAUNCH_FLOW_DONE|已进入同花顺模拟交易页"
end launchFlow

on clickLoginButton(targetWindow)
	set loginButton to my findNamedControl(targetWindow, {"登录", "交易登录", "登录交易", "登录账号", "登录账户"})
	if loginButton is missing value then return false
	try
		set winText to my collectElementText(targetWindow)
	on error
		set winText to ""
	end try
	if winText contains "模拟练习" then return false

	my pressControl(loginButton)
	return true
end clickLoginButton

on isMainTradingWindow(targetWindow)
	return my shallowTextContains(targetWindow, {"资金股份", "持仓", "当日委托", "买入", "卖出", "模拟练习"})
end isMainTradingWindow

on waitForMainTradingWindow(maxSeconds)
	repeat (maxSeconds * 10) times
		set candidate to my firstThsWindow()
		if candidate is not missing value and my isMainTradingWindow(candidate) then return candidate
		delay 0.1
	end repeat
	return missing value
end waitForMainTradingWindow

on clickSidebarTradeButton(targetWindow)
	if my shallowTextContains(targetWindow, {"资金股份", "持仓", "当日委托"}) then
		if my elementContainsText(targetWindow, "模拟练习") then return
	end if
	set tradeButton to my findNamedControl(targetWindow, {"交易"})
	if tradeButton is missing value then
		set tradeButton to my findClickableByText(targetWindow, "交易")
	end if
	if tradeButton is missing value then error "未识别到侧边栏交易按钮"
	my pressControl(tradeButton)
	repeat 100 times
		if my shallowTextContains(targetWindow, {"资金股份", "持仓", "当日委托", "买入", "卖出"}) then exit repeat
		delay 0.05
	end repeat
end clickSidebarTradeButton

on clickSimulationTab(targetWindow)
	if my elementContainsText(targetWindow, "模拟练习") then return
	set simButton to my findNamedControl(targetWindow, {"模拟", "模拟交易", "模拟练习"})
	if simButton is missing value then set simButton to my findClickableByText(targetWindow, "模拟")
	if simButton is missing value then error "未识别到模拟 tab"
	my pressControl(simButton)
	repeat 100 times
		if my elementContainsText(targetWindow, "模拟练习") then return
		delay 0.05
	end repeat
	error "点击模拟 tab 后未确认进入模拟交易页（未找到“模拟练习”特征）"
end clickSimulationTab

on findClickableByText(rootElement, wantedText)
	tell application "System Events"
		try
			set allItems to {rootElement} & (entire contents of rootElement)
		on error
			set allItems to {rootElement}
		end try
		repeat with uiItem in allItems
			try
				set itemRole to role of uiItem as text
				-- 严禁点击静态文本，只接受真正可交互的控件角色
				if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab"} then
					set itemName to my elementName(uiItem)
					if itemName contains wantedText then return contents of uiItem
				end if
			end try
		end repeat
	end tell
	return missing value
end findClickableByText

-- ---------------------------------------------------------------------------
-- 窗口定位与退出
-- ---------------------------------------------------------------------------

on waitForThsWindow(maxSeconds)
	repeat (maxSeconds * 10) times
		set candidate to my firstThsWindow()
		if candidate is not missing value then return candidate
		delay 0.1
	end repeat
	return missing value
end waitForThsWindow

on firstThsWindow()
	tell application "System Events"
		try
			if not (exists process "同花顺") then return missing value
			tell process "同花顺"
				if (count of windows) is 0 then return missing value
				repeat with w in windows
					return contents of w
				end repeat
			end tell
		on error
			return missing value
		end try
	end tell
	return missing value
end firstThsWindow

on quitThs()
	tell application "System Events"
		if not (exists process "同花顺") then return "QUIT_NOT_RUNNING|同花顺未在运行"
	end tell
	try
		tell application "System Events"
			repeat 30 times
				tell process "同花顺" to set frontmost to true
				if not (exists process "同花顺") then return "QUIT_OK|同花顺已退出"
				delay 0.2
			end repeat
		end tell
	end try
	try
		tell application "同花顺" to quit
		delay 1
	end try
	tell application "System Events"
		repeat 30 times
			if not (exists process "同花顺") then return "QUIT_OK|同花顺已退出"
			delay 0.2
		end repeat
	end tell
	return "QUIT_PENDING|同花顺未在超时内退出，由调用方 pkill 兜底"
end quitThs

-- ---------------------------------------------------------------------------
-- 通用 accessibility handler（带严格过滤）
-- ---------------------------------------------------------------------------

on findNamedControl(rootElement, wantedNames)
	tell application "System Events"
		try
			if (role of rootElement as text) is "AXWindow" then
				set candidateItems to (buttons of rootElement)
			else
				set candidateItems to {rootElement} & (entire contents of rootElement)
			end if
		on error
			set candidateItems to {rootElement}
		end try
		repeat with uiItem in candidateItems
			try
				set itemRole to role of uiItem as text
				if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab"} then
					set itemName to my elementName(uiItem)
					if itemName is in wantedNames then
						return contents of uiItem
					end if
				end if
			end try
		end repeat
	end tell
	return missing value
end findNamedControl

on pressControl(uiControl)
	tell application "System Events"
		try
			-- 检查是否可用
			set isEnabled to true
			try
				set isEnabled to (enabled of uiControl)
			end try
			if not isEnabled then error "控件当前不可用 (enabled = false)"

			perform action "AXPress" of uiControl
			return
		end try
		try
			click uiControl
			return
		end try
	end tell
	error "控件无法点击：" & my elementName(uiControl)
end pressControl

on shallowTextContains(rootElement, wantedTexts)
	tell application "System Events"
		tell rootElement
			try
				repeat with t in static texts
					set tx to my elementText(t)
					repeat with i from 1 to count of wantedTexts
						set wanted to item i of wantedTexts as text
						if tx contains wanted then return true
					end repeat
				end repeat
				repeat with b in buttons
					set bn to my elementName(b)
					repeat with i from 1 to count of wantedTexts
						set wanted to item i of wantedTexts as text
						if bn contains wanted then return true
					end repeat
				end repeat
			end try
		end tell
	end tell
	return false
end shallowTextContains

on collectElementText(rootElement)
	set textParts to {}
	tell application "System Events"
		set allItems to {rootElement}
		try
			set allItems to allItems & (entire contents of rootElement)
		end try
		repeat with uiItem in allItems
			set itemText to my elementText(uiItem)
			if itemText is not "" and itemText is not in textParts then set end of textParts to itemText
		end repeat
	end tell
	return my joinList(textParts, " ")
end collectElementText

on elementContainsText(rootElement, wantedText)
	tell application "System Events"
		try
			if (role of rootElement as text) is "AXWindow" then
				if wantedText is "模拟练习" then
					if (exists button "模拟股票" of rootElement) or (exists static text "模拟练习" of rootElement) or (exists static text "模拟股票" of rootElement) then return true
				end if
				set allItems to (static texts of rootElement) & (buttons of rootElement)
			else
				set allItems to {rootElement} & (entire contents of rootElement)
			end if
		on error
			set allItems to {rootElement}
		end try
		repeat with uiItem in allItems
			if my elementText(uiItem) contains wantedText then return true
		end repeat
	end tell
	return false
end elementContainsText

on elementName(uiItem)
	tell application "System Events"
		try
			set itemName to name of uiItem
			if itemName is not missing value then return itemName as text
		end try
		try
			set itemDescription to description of uiItem
			if itemDescription is not missing value then return itemDescription as text
		end try
	end tell
	return ""
end elementName

on elementText(uiItem)
	tell application "System Events"
		try
			set itemValue to value of uiItem
			if itemValue is not missing value and (itemValue as text) is not "" then return my sanitize(itemValue as text)
		end try
		set itemName to my elementName(uiItem)
		if itemName is not "" then return my sanitize(itemName)
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

On replaceText(findText, replacementText, sourceText)
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
